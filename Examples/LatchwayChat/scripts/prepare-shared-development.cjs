/* This generated local overlay is an example-only build input, never an npm release. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const snapshotMarker = '.latchway-source-snapshot.json';

function filesIn(directory) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Refusing a symlink in the iOS source snapshot: ' + name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error('Unexpected iOS snapshot entry: ' + name);
    }
  }
  visit('');
  return files.sort();
}

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function readOwnedSnapshot(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('The iOS overlay must be a real directory');
  const names = filesIn(directory);
  if (!names.includes(snapshotMarker)) throw new Error('Refusing an unowned iOS overlay directory');
  const marker = JSON.parse(fs.readFileSync(path.join(directory, snapshotMarker), 'utf8'));
  if (marker.format !== 1 || marker.source !== 'ios' || !marker.files ||
      Object.keys(marker).sort().join('|') !== 'files|format|source' ||
      Object.keys(marker.files).sort().join('|') !== names.filter(name => name !== snapshotMarker).join('|')) {
    throw new Error('Invalid iOS source snapshot ownership manifest');
  }
  for (const name of names.filter(name => name !== snapshotMarker)) {
    if (!/\.(h|m|mm|swift)$/.test(name) || marker.files[name] !== hash(fs.readFileSync(path.join(directory, name)))) {
      throw new Error('Refusing to overwrite modified iOS snapshot content: ' + name);
    }
  }
  return marker;
}

function verifyIOSSnapshot(source, directory) {
  const marker = readOwnedSnapshot(directory);
  const names = filesIn(source).filter(name => /\.(h|m|mm|swift)$/.test(name));
  if (names.join('|') !== Object.keys(marker.files).sort().join('|')) throw new Error('iOS source snapshot file set is stale');
  for (const name of names) {
    if (marker.files[name] !== hash(fs.readFileSync(path.join(source, name)))) throw new Error('iOS source snapshot is stale: ' + name);
  }
  for (const required of ['LatchwayNativeBridge.swift', 'RCTNativeLatchway.mm', 'RCTNativeLatchway.h']) {
    if (!names.includes(required)) throw new Error('Missing native bridge source: ' + required);
  }
}

function removeOwnedSnapshot(directory) {
  readOwnedSnapshot(directory);
  const directories = new Set();
  for (const name of filesIn(directory)) {
    fs.unlinkSync(path.join(directory, name));
    let parent = path.dirname(name);
    while (parent !== '.') { directories.add(parent); parent = path.dirname(parent); }
  }
  for (const name of [...directories].sort((a, b) => b.length - a.length)) fs.rmdirSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

function prepareIOSSnapshot(source, overlay) {
  if (fs.lstatSync(source).isSymbolicLink() || !fs.lstatSync(source).isDirectory()) throw new Error('Expected the SDK iOS source directory');
  if (fs.lstatSync(overlay).isSymbolicLink() || !fs.lstatSync(overlay).isDirectory()) throw new Error('Refusing an unexpected overlay root');
  const target = path.join(overlay, 'ios');
  let existing;
  try { existing = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) {
    if (fs.realpathSync(target) !== fs.realpathSync(source) ||
        path.resolve(overlay, fs.readlinkSync(target)) !== path.resolve(source)) {
      throw new Error('Refusing to replace an unexpected iOS overlay symlink');
    }
  } else if (existing) {
    readOwnedSnapshot(target);
  }
  const staging = fs.mkdtempSync(path.join(overlay, '.ios-snapshot-'));
  const marker = {format: 1, source: 'ios', files: {}};
  for (const name of filesIn(source).filter(name => /\.(h|m|mm|swift)$/.test(name))) {
    const bytes = fs.readFileSync(path.join(source, name));
    fs.mkdirSync(path.dirname(path.join(staging, name)), {recursive: true});
    fs.writeFileSync(path.join(staging, name), bytes, {flag: 'wx'});
    marker.files[name] = hash(bytes);
  }
  fs.writeFileSync(path.join(staging, snapshotMarker), JSON.stringify(marker, null, 2) + '\n', {flag: 'wx'});
  verifyIOSSnapshot(source, staging);
  let previous;
  if (existing?.isSymbolicLink()) fs.unlinkSync(target); // Only the exact SDK/ios link validated above.
  else if (existing) {
    previous = path.join(overlay, '.ios-previous-' + crypto.randomUUID());
    fs.renameSync(target, previous);
  }
  try { fs.renameSync(staging, target); }
  catch (error) { if (previous) fs.renameSync(previous, target); throw error; }
  if (previous) removeOwnedSnapshot(previous);
}

function main() {
const app = path.resolve(__dirname, '..');
const sdk = path.resolve(app, '../..');
const ios = path.resolve(sdk, '../latchway-ios-sdk');
const overlay = path.join(app, '.latchway-development');
if (process.env.LATCHWAY_SHARED_NATIVE_SOURCE !== '1') {
  throw new Error('Set LATCHWAY_SHARED_NATIVE_SOURCE=1 explicitly for local SDK development. Normal shared-app setup uses the released npm/native packages without this overlay.');
}
const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8'));
const spec = fs.readFileSync(path.join(ios, 'Latchway.podspec'), 'utf8');
const version = spec.match(/spec\.version\s*=\s*['"]([^'"]+)['"]/)[1];
execFileSync(process.execPath, [path.join(sdk, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {cwd: sdk, stdio: 'inherit'});
fs.mkdirSync(overlay, {recursive: true});
// CocoaPods' source glob does not traverse this directory symlink. Real files
// are required or it silently creates an aggregate target with no native bridge.
prepareIOSSnapshot(path.join(sdk, 'ios'), overlay);
for (const name of ['android', 'src', 'lib', 'LICENSE', 'README.md', 'react-native.config.cjs']) {
  const target = path.join(overlay, name);
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== fs.realpathSync(path.join(sdk, name))) {
      throw new Error('Refusing to replace an unexpected development overlay entry: ' + name);
    }
  } else fs.symlinkSync(path.relative(overlay, path.join(sdk, name)), target);
}
fs.writeFileSync(path.join(overlay, 'package.json'), JSON.stringify({...manifest, private: true}, null, 2) + '\n');
fs.writeFileSync(path.join(overlay, 'LatchwayReactNative.podspec'),
  fs.readFileSync(path.join(sdk, 'LatchwayReactNative.podspec'), 'utf8')
    .replace(/spec\.dependency "Latchway\/AppAttest", "[^"]+"/, `spec.dependency "Latchway/AppAttest", "${version}"`));
const clientConfig = fs.readFileSync(path.join(app, 'src/config.local.json'));
fs.writeFileSync(path.join(app, 'ios/LatchwayChat/SharedNativeConfig.json'), clientConfig);
fs.mkdirSync(path.join(app, 'android/app/src/main/assets'), {recursive: true});
fs.writeFileSync(path.join(app, 'android/app/src/main/assets/SharedNativeConfig.json'), clientConfig);
console.log('Prepared private source overlay. Use the same development flag for Metro, autolinking and CocoaPods. No registry publication occurred.');
}

module.exports = {prepareIOSSnapshot, verifyIOSSnapshot};
if (require.main === module) main();
