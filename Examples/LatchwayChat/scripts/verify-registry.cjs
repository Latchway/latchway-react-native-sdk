const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
assert.notEqual(process.env.LATCHWAY_SHARED_NATIVE_SOURCE, '1', 'Unset the source-development toggle to verify registry inputs');
const javascriptOnly = process.argv.includes('--javascript-only');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  assert(!pkg.link, 'Local dependency link: ' + location);
  assert(!/^(file:|link:|workspace:)/.test(pkg.resolved || ''), 'Local dependency: ' + location);
}
for (const name of ['@latchway/react-native', '@latchway/client', '@latchway/langchain']) {
  const location = 'node_modules/' + name;
  const pkg = lock.packages[location];
  const expected = {'@latchway/client': '1.1.0', '@latchway/langchain': '1.1.0', '@latchway/react-native': '1.2.0'};
  assert.equal(pkg.version, expected[name]);
  assert.equal(new URL(pkg.resolved).origin, 'https://registry.npmjs.org');
  assert(pkg.integrity.startsWith('sha512-'));
  assert.equal(fs.realpathSync(path.join(root, location)), path.join(root, location));
  const installed = JSON.parse(fs.readFileSync(path.join(root, location, 'package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  console.log(name + '@' + pkg.version + ' — npm registry, integrity locked, no local link');
}
const nativePackageRoot = path.join(root, 'node_modules/@latchway/react-native');
const linked = JSON.parse(execFileSync(process.execPath, [path.join(root, 'node_modules/react-native/cli.js'), 'config'],
  {cwd: root, encoding: 'utf8'}));
assert.equal(fs.realpathSync(linked.dependencies['@latchway/react-native'].root), nativePackageRoot,
  'Native autolinking must use the installed npm package, not the development overlay');
const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
assert(!tsconfig.compilerOptions?.paths?.['@latchway/react-native'], 'TypeScript must verify installed package declarations');
const nativeBuild = fs.readFileSync(path.join(nativePackageRoot, 'android/build.gradle.kts'), 'utf8');
assert(nativeBuild.includes('dev.latchway:latchway-okhttp:1.1.0'));
assert(nativeBuild.includes('dev.latchway:latchway-play-integrity:1.1.0'));
assert(fs.readFileSync(path.join(nativePackageRoot, 'LatchwayReactNative.podspec'), 'utf8')
  .includes('spec.dependency "Latchway/AppAttest", "1.2.0"'));
console.log('TypeScript and native autolinking use npm; native dependency pins are iOS1.2.0 / Android1.1.0');
const podLock = path.join(root, 'ios/Podfile.lock');
if (!javascriptOnly && fs.existsSync(podLock)) {
  const pods = fs.readFileSync(podLock, 'utf8');
  assert(pods.includes('Latchway/AppAttest (1.2.0)'));
  assert(pods.includes('LatchwayReactNative (1.2.0)'));
  assert(!/\n  Latchway:\n    :path:/.test(pods));
  assert(!pods.includes('.latchway-development'));
  console.log('Native iOS: CocoaPods Latchway/AppAttest1.2.0 + npm bridge1.2.0 (no local SDK override)');
} else {
  console.log('CocoaPods resolution not checked in this invocation; run without --javascript-only after Pod install');
}
