import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import './build.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_ZIP = path.join(ROOT_DIR, 'aep-consent-analyzer.zip');

const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'index.html',
  'src/core/consent-engine.js',
  'src/extension/content-script.js',
  'src/extension/page-hook.js',
  'src/simulator/alloy-simulator.js',
  'src/ui/app.js',
  'src/ui/styles.css'
];

// Precompute CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function createZipArchive(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const { dosTime, dosDate } = getDosDateTime();

  for (const relPath of files) {
    const fullPath = path.join(DIST_DIR, relPath);
    const uncompressedData = fs.readFileSync(fullPath);
    const compressedData = zlib.deflateRawSync(uncompressedData, { level: 9 });
    const fileCrc = crc32(uncompressedData);
    const nameBuf = Buffer.from(relPath.replace(/\\/g, '/'), 'utf8');

    // Local file header (30 bytes + file name)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6); // General purpose bit flag
    localHeader.writeUInt16LE(8, 8); // Compression method (8 = Deflate)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(uncompressedData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central directory file header (46 bytes + file name)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central file header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed to extract
    centralHeader.writeUInt16LE(0, 8); // General purpose bit flag
    centralHeader.writeUInt16LE(8, 10); // Compression method (Deflate)
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(uncompressedData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirBuffer = Buffer.concat(centralHeaders);
  const endOfCentralDir = Buffer.alloc(22);
  endOfCentralDir.writeUInt32LE(0x06054b50, 0); // End of central dir signature
  endOfCentralDir.writeUInt16LE(0, 4); // Number of this disk
  endOfCentralDir.writeUInt16LE(0, 6); // Disk where central directory starts
  endOfCentralDir.writeUInt16LE(files.length, 8); // Total entries on this disk
  endOfCentralDir.writeUInt16LE(files.length, 10); // Total entries in central directory
  endOfCentralDir.writeUInt32LE(centralDirBuffer.length, 12); // Size of central directory
  endOfCentralDir.writeUInt32LE(offset, 16); // Offset of start of central directory
  endOfCentralDir.writeUInt16LE(0, 20); // ZIP file comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, endOfCentralDir]);
}

console.log('\nPackaging unpacked Chrome Extension into ZIP archive...');
const zipBuffer = createZipArchive(EXTENSION_FILES);
fs.writeFileSync(OUTPUT_ZIP, zipBuffer);

const sizeKb = (zipBuffer.length / 1024).toFixed(1);
console.log(`✓ Created ZIP archive (${sizeKb} KB):`);
console.log(`  ${OUTPUT_ZIP}`);
console.log('\nHow the recipient loads it:');
console.log('  1. Unzip aep-consent-analyzer.zip');
console.log('  2. Open chrome://extensions/ and enable "Developer mode"');
console.log('  3. Click "Load unpacked" and select the unzipped folder');
