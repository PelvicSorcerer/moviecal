#!/usr/bin/env node
// Host telemetry sampler. `--once` prints one sample and exits. MOV-494.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
