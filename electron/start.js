/**
 * Starts the desktop app from the project (dev or a local test of the export).
 * Clears ELECTRON_RUN_AS_NODE, which some tools (e.g. VS Code terminals) set and which
 * would make Electron run as plain Node instead of opening a window.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const electronBinary = require('electron'); // resolves to the Electron executable path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
