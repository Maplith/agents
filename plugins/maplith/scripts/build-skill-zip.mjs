// Packs skills/maplith/SKILL.md as dist/maplith-skill.zip, the file a person
// uploads to Claude (Settings → Capabilities → Skills) when they do not use
// Claude Code. The zip holds one folder, maplith/, with SKILL.md in it.
//
//   node scripts/build-skill-zip.mjs           write dist/maplith-skill.zip
//   node scripts/build-skill-zip.mjs --check   exit 1 if it is out of date
//
// The bytes depend on SKILL.md alone: stored (not compressed), with a fixed
// timestamp, so a rebuild of the same text gives the same file and the check
// can compare bytes. No dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_PATH = join(ROOT, 'skills', 'maplith', 'SKILL.md');
export const ZIP_PATH = join(ROOT, 'dist', 'maplith-skill.zip');
export const ENTRY = 'maplith/SKILL.md';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00 in MS-DOS date and time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A zip with one stored file. */
export function skillZip(content) {
  const name = Buffer.from(ENTRY, 'utf8');
  const data = Buffer.from(content);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(0, 42); // offset of the local header
  const localSize = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const zip = skillZip(readFileSync(SKILL_PATH));
  if (process.argv.includes('--check')) {
    let have = null;
    try {
      have = readFileSync(ZIP_PATH);
    } catch {
      have = null;
    }
    if (!have || !have.equals(zip)) {
      console.error('dist/maplith-skill.zip is out of date: run node scripts/build-skill-zip.mjs');
      process.exit(1);
    }
    console.log('dist/maplith-skill.zip matches skills/maplith/SKILL.md');
  } else {
    mkdirSync(dirname(ZIP_PATH), { recursive: true });
    writeFileSync(ZIP_PATH, zip);
    console.log(`wrote dist/maplith-skill.zip (${zip.length} bytes)`);
  }
}
