// Zero-dependency VSIX packager for the Antigravity IDE extension (`npm run vsix`).
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
	const localParts = [];
	const centralParts = [];
	let offset = 0;

	for (const { name, data } of entries) {
		const entryName = name.replace(/\\/g, '/');
		const nameBuf = Buffer.from(entryName, 'utf8');
		const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
		const compressed = deflateRawSync(raw);
		const crc = crc32(raw);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x0021, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0x0021, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		localParts.push(local, compressed);
		centralParts.push(central);
		offset += local.length + compressed.length;
	}

	const centralDir = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDir, eocd]);
}

const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function contentTypesXml() {
	return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".mjs" ContentType="application/javascript"/>
  <Default Extension=".cjs" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".yml" ContentType="text/yaml"/>
</Types>
`;
}

function vsixManifestXml(pkg) {
	return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEsc(pkg.name)}" Version="${xmlEsc(pkg.version)}" Publisher="${xmlEsc(pkg.publisher)}"/>
    <DisplayName>${xmlEsc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEsc(pkg.description || '')}</Description>
    <Categories>${xmlEsc((pkg.categories || ['Other']).join(','))}</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`;
}

export function packVsix(outFile = path.join(repoRoot, 'prompt-enhancer-antigravity.vsix')) {
	const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
	const packagedPkg = { ...pkg, main: './antigravity/extension.cjs' };

	const coreDir = path.join(repoRoot, 'core');
	const coreFiles = readdirSync(coreDir, { withFileTypes: true })
		.filter(d => d.isFile())
		.map(d => d.name)
		.sort();

	const entries = [
		{ name: '[Content_Types].xml', data: contentTypesXml() },
		{ name: 'extension.vsixmanifest', data: vsixManifestXml(pkg) },
		{ name: 'extension/package.json', data: JSON.stringify(packagedPkg, null, 2) + '\n' },
		{ name: 'extension/antigravity/extension.cjs', data: readFileSync(path.join(here, 'extension.cjs')) },
		{ name: 'extension/antigravity/index.mjs', data: readFileSync(path.join(here, 'index.mjs')) },
		...coreFiles.map(name => ({
			name: `extension/core/${name}`,
			data: readFileSync(path.join(coreDir, name)),
		})),
	];

	const resolved = path.resolve(outFile);
	mkdirSync(path.dirname(resolved), { recursive: true });
	writeFileSync(resolved, buildZip(entries));
	return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const out = packVsix(process.argv[2]);
	process.stdout.write(`${out}\n`);
}
