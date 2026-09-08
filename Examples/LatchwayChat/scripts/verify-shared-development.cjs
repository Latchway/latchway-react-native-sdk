const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {prepareIOSSnapshot, verifyIOSSnapshot} = require('./prepare-shared-development.cjs');

function verifyNativeBridgeTarget(project) {
  const objects = project.objects;
  assert(objects && typeof objects === 'object', 'Missing CocoaPods project objects');
  const targets = Object.values(objects).filter(value => value.name === 'LatchwayReactNative' &&
    ['PBXNativeTarget', 'PBXAggregateTarget'].includes(value.isa));
  assert.equal(targets.length, 1, 'Expected exactly one CocoaPods bridge target');
  assert.equal(targets[0].isa, 'PBXNativeTarget', 'Bridge pod is source-less; regenerate Pods after preparing the real iOS source snapshot');
  const sourceNames = new Set();
  for (const id of targets[0].buildPhases ?? []) {
    const phase = objects[id];
    if (phase?.isa !== 'PBXSourcesBuildPhase') continue;
    for (const buildID of phase.files ?? []) {
      const file = objects[objects[buildID]?.fileRef];
      if (file?.path) sourceNames.add(path.basename(file.path));
    }
  }
  for (const name of ['LatchwayNativeBridge.swift', 'RCTNativeLatchway.mm']) {
    assert(sourceNames.has(name), 'Native bridge is missing from the pod Sources phase: ' + name);
  }
}

function selfTest() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'latchway-overlay-regression-'));
  const source = path.join(fixture, 'sdk-ios');
  const overlay = path.join(fixture, 'overlay');
  fs.mkdirSync(source); fs.mkdirSync(overlay);
  for (const name of ['LatchwayNativeBridge.swift', 'RCTNativeLatchway.mm', 'RCTNativeLatchway.h']) {
    fs.writeFileSync(path.join(source, name), '// fixture source\n');
  }
  const target = path.join(overlay, 'ios');
  fs.symlinkSync(path.relative(overlay, source), target);
  assert.throws(() => verifyIOSSnapshot(source, target), /real directory/);
  prepareIOSSnapshot(source, overlay);
  verifyIOSSnapshot(source, target);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  fs.writeFileSync(path.join(source, 'LatchwayNativeBridge.swift'), '// updated fixture\n');
  assert.throws(() => verifyIOSSnapshot(source, target), /stale/);
  prepareIOSSnapshot(source, overlay);
  verifyIOSSnapshot(source, target);
  fs.writeFileSync(path.join(target, 'RCTNativeLatchway.mm'), '// unrelated edit\n');
  assert.throws(() => prepareIOSSnapshot(source, overlay), /modified/);
  const unrelated = path.join(fixture, 'unrelated-overlay');
  fs.mkdirSync(unrelated); fs.mkdirSync(path.join(unrelated, 'ios'));
  assert.throws(() => prepareIOSSnapshot(source, unrelated), /unowned/);
  const wrong = path.join(fixture, 'wrong-link-overlay');
  fs.mkdirSync(wrong); fs.symlinkSync(unrelated, path.join(wrong, 'ios'));
  assert.throws(() => prepareIOSSnapshot(source, wrong), /unexpected iOS overlay symlink/);
  const objects = {target: {isa: 'PBXAggregateTarget', name: 'LatchwayReactNative'}};
  assert.throws(() => verifyNativeBridgeTarget({objects}), /source-less/);
  objects.target = {isa: 'PBXNativeTarget', name: 'LatchwayReactNative', buildPhases: ['sources']};
  objects.sources = {isa: 'PBXSourcesBuildPhase', files: ['generated']};
  objects.generated = {fileRef: 'generatedFile'};
  objects.generatedFile = {path: 'LatchwayReactNativeSpec-generated.mm'};
  assert.throws(() => verifyNativeBridgeTarget({objects}), /missing from the pod Sources/);
  objects.sources.files.push('swift', 'objc');
  objects.swift = {fileRef: 'swiftFile'}; objects.swiftFile = {path: 'ios/LatchwayNativeBridge.swift'};
  objects.objc = {fileRef: 'objcFile'}; objects.objcFile = {path: 'ios/RCTNativeLatchway.mm'};
  verifyNativeBridgeTarget({objects});
  // Keep this uniquely owned, non-secret fixture for inspection; no broad deletion.
  console.log('Overlay regression passed: real-file snapshot, safe refresh/refusal, native Sources membership. Fixture: ' + fixture);
}

function main() {
const app = path.resolve(__dirname, '..');
assert.equal(process.env.LATCHWAY_SHARED_NATIVE_SOURCE, '1', 'Explicit source-development flag required');
const root = path.resolve(app, '../..');
const overlay = path.join(app, '.latchway-development');
const linked = JSON.parse(execFileSync(process.execPath, [path.join(app, 'node_modules/react-native/cli.js'), 'config'],
  {cwd: app, encoding: 'utf8'}));
assert.equal(fs.realpathSync(linked.dependencies['@latchway/react-native'].root), fs.realpathSync(overlay));
verifyIOSSnapshot(path.join(root, 'ios'), path.join(overlay, 'ios'));
for (const folder of ['android', 'src', 'lib']) {
  assert.equal(fs.realpathSync(path.join(overlay, folder)), fs.realpathSync(path.join(root, folder)));
}
const lock = fs.readFileSync(path.join(app, 'ios/Podfile.lock'), 'utf8');
assert.equal((lock.match(/^  - Latchway\/Core \(/gm) ?? []).length, 1);
assert(lock.includes(':path: "../../../../latchway-ios-sdk"'));
assert(lock.includes(':path: "../.latchway-development"'));
assert(!fs.readFileSync(path.join(app, 'ios/LatchwayChat.xcodeproj/project.pbxproj'), 'utf8').includes('XCRemoteSwiftPackageReference'));
const packageJSON = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert(!Object.keys(packageJSON.dependencies).some(name => /firebase|langchain/.test(name)));
const podsProject = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-',
  path.join(app, 'ios/Pods/Pods.xcodeproj/project.pbxproj')], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}));
verifyNativeBridgeTarget(podsProject);
console.log('One local RN source overlay, bridge Swift/ObjC++ Sources, and one CocoaPods Latchway Core implementation; no SPM duplicate or mandatory Firebase/LangChain SDK dependency. This verifies build inputs, not final linkage, publication or physical-device proof.');
}

module.exports = {verifyNativeBridgeTarget};
if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}
