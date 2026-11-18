// CommonJS entry point for VS Code / Antigravity IDE extension host; delegates to ESM index.mjs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let modPromise;
function load() {
	return (modPromise ||= import(pathToFileURL(fs.realpathSync(path.join(__dirname, 'index.mjs'))).href));
}

exports.activate = async function activate(context) {
	const vscode = require('vscode');
	const mod = await load();
	return mod.activateWith(context, vscode);
};

exports.deactivate = async function deactivate() {
	if (!modPromise) return;
	const mod = await modPromise;
	return mod.deactivate();
};
