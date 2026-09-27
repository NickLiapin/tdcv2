/**
 * The registry is reached through the proxy the environment names — the rule
 * curl and npm use, and the one all five implementations share. The shared
 * CLI fixture pins what a failure says; these pin the rule itself and a GET
 * that really goes through a proxy, with no network: an origin and a proxy on
 * the loopback.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { proxiedGet, proxyFor } from '../../src/cli/proxied-get.js';

const PROXY_VARIABLES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
];

const saved = new Map(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
const servers: Server[] = [];

function clearProxies(): void {
  for (const name of PROXY_VARIABLES) Reflect.deleteProperty(process.env, name);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  for (const server of servers.splice(0)) server.close();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe('the proxy rule', () => {
  it('reads the lower-case variable first, then the upper-case, then all_proxy', () => {
    const target = new URL('https://registry.example/index.json');
    expect(
      proxyFor(target, { https_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:2' })?.variable,
    ).toBe('https_proxy');
    expect(proxyFor(target, { HTTPS_PROXY: 'http://b:2', ALL_PROXY: 'http://c:3' })?.variable).toBe(
      'HTTPS_PROXY',
    );
    expect(proxyFor(target, { ALL_PROXY: 'http://c:3' })?.shown).toBe('http://c:3');
    expect(proxyFor(new URL('http://registry.example/'), { HTTPS_PROXY: 'http://b:2' })).toBe(
      undefined,
    );
  });

  it('spells the port out and leaves the credentials out of what it shows', () => {
    const choice = proxyFor(new URL('https://r.example/'), {
      HTTPS_PROXY: 'http://user:secret@proxy.corp',
    });
    expect(choice?.shown).toBe('http://proxy.corp:80');
    expect(choice?.url.password).toBe('secret');
  });

  it('sends the hosts NO_PROXY lists direct: the host, the ones under it, or all', () => {
    const env = { HTTPS_PROXY: 'http://p:1' };
    const target = new URL('https://raw.example.com/x');
    expect(proxyFor(target, { ...env, NO_PROXY: 'example.com' })).toBeUndefined();
    expect(proxyFor(target, { ...env, no_proxy: '.example.com:443' })).toBeUndefined();
    expect(proxyFor(target, { ...env, NO_PROXY: '*' })).toBeUndefined();
    expect(proxyFor(target, { ...env, NO_PROXY: 'ample.com' })).toBeDefined();
  });

  it('refuses a proxy variable that is not an address, by name', () => {
    expect(() => proxyFor(new URL('https://r.example/'), { HTTPS_PROXY: 'bad@@value:x' })).toThrow(
      'HTTPS_PROXY="bad@@value:x" is not a proxy address',
    );
  });
});

describe('a GET through a proxy', () => {
  it('goes through the proxy, sends its credentials, and follows a redirect', async () => {
    clearProxies();
    const originPort = await listen(
      createServer((req, res) => {
        if (req.url === '/old') {
          res.writeHead(302, { location: '/new' }).end();
          return;
        }
        res.end('the index');
      }),
    );
    const seen: string[] = [];
    const proxyPort = await listen(
      createServer((req, res) => {
        seen.push(`${req.url ?? ''} ${req.headers['proxy-authorization'] ?? 'none'}`);
        const target = new URL(req.url ?? '');
        const upstream = request(
          { host: target.hostname, port: target.port, path: target.pathname, method: 'GET' },
          (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
          },
        );
        upstream.end();
      }),
    );
    process.env['HTTP_PROXY'] = `http://user:pw@127.0.0.1:${String(proxyPort)}`;
    const body = await proxiedGet(`http://127.0.0.1:${String(originPort)}/old`);
    expect(Buffer.from(body).toString('utf8')).toBe('the index');
    const auth = `Basic ${Buffer.from('user:pw').toString('base64')}`;
    expect(seen).toEqual([
      `http://127.0.0.1:${String(originPort)}/old ${auth}`,
      `http://127.0.0.1:${String(originPort)}/new ${auth}`,
    ]);
  });

  it('goes direct when NO_PROXY names the host', async () => {
    clearProxies();
    const originPort = await listen(createServer((_req, res) => res.end('direct')));
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:9';
    process.env['NO_PROXY'] = '127.0.0.1';
    const body = await proxiedGet(`http://127.0.0.1:${String(originPort)}/`);
    expect(Buffer.from(body).toString('utf8')).toBe('direct');
  });
});
