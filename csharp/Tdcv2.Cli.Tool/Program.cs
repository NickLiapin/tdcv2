// The process wrapper, and nothing else.
//
// Every decision lives in Tdcv2.Cli.Main, which takes its two writers as parameters and returns an
// exit code rather than calling Environment.Exit. That is what lets the whole command line be driven
// by the shared cli.json fixture in-process — a CLI tested by spawning processes is slow enough that
// it gets tested less, and the exit code is half the contract.
return Tdcv2.Cli.Main.Run(args, Console.Out, Console.Error);
