import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DataSourceResolutionError,
  resolveDataSourcePath,
  resolveExistingDataSourcePath,
} from '../../src/data-source/index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tdc-data-source-'));
}

describe('data source resolver', () => {
  it('resolves relative sources against baseDir first', () => {
    const root = tempRoot();
    const file = join(root, 'names.txt');
    writeFileSync(file, 'Alice\n');

    expect(resolveExistingDataSourcePath('names.txt', { baseDir: root }).path).toBe(file);
  });

  it('falls back to configured dataPaths for relative sources', () => {
    const root = tempRoot();
    const data = join(root, 'data');
    mkdirSync(data);
    const file = join(data, 'cities.txt');
    writeFileSync(file, 'Paris\n');

    expect(
      resolveExistingDataSourcePath('cities.txt', {
        baseDir: join(root, 'configs'),
        dataPaths: [data],
      }).path,
    ).toBe(file);
  });

  it('resolves explicit @data aliases only through dataPaths', () => {
    const root = tempRoot();
    const data = join(root, 'data');
    mkdirSync(data);
    const file = join(data, 'users.csv');
    writeFileSync(file, 'email\na@example.test\n');

    expect(resolveExistingDataSourcePath('@data/users.csv', { dataPaths: [data] }).path).toBe(file);
  });

  it('resolves file URLs', () => {
    const root = tempRoot();
    const file = join(root, 'list.txt');
    writeFileSync(file, 'x\n');

    expect(resolveExistingDataSourcePath(pathToFileURL(file).href).path).toBe(file);
  });

  it('resolves package data sources from node_modules near baseDir', () => {
    const root = tempRoot();
    const packageData = join(root, 'node_modules', '@tdc', 'data-demo', 'names.txt');
    mkdirSync(join(root, 'node_modules', '@tdc', 'data-demo'), { recursive: true });
    writeFileSync(packageData, 'Alice\n');

    expect(
      resolveExistingDataSourcePath('pkg:@tdc/data-demo/names.txt', { baseDir: root }).path,
    ).toBe(packageData);
  });

  it('reports all attempted paths when a source cannot be read', () => {
    const root = tempRoot();
    const data = join(root, 'data');
    mkdirSync(data);

    expect(() =>
      resolveExistingDataSourcePath('missing.txt', { baseDir: root, dataPaths: [data] }),
    ).toThrow(DataSourceResolutionError);
    const unresolved = resolveDataSourcePath('missing.txt', { baseDir: root, dataPaths: [data] });
    expect(unresolved.attempts).toEqual([join(root, 'missing.txt'), join(data, 'missing.txt')]);
  });
});
