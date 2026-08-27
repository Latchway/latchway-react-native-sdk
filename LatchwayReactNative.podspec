require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |spec|
  spec.name = "LatchwayReactNative"
  spec.version = package["version"]
  spec.summary = package["description"]
  spec.homepage = package["homepage"]
  spec.license = { type: "Apache-2.0", file: "LICENSE" }
  spec.author = { "Latchway Contributors" => "security@latchway.dev" }
  spec.source = { git: "https://github.com/Latchway/latchway-react-native-sdk.git", tag: spec.version.to_s }
  spec.platforms = { ios: "15.0" }
  spec.source_files = "ios/**/*.{h,m,mm,swift}"
  spec.requires_arc = true
  spec.swift_version = "6.0"
  spec.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "DEFINES_MODULE" => "YES",
  }

  spec.dependency "Latchway/AppAttest", "0.1.0"
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(spec)
  else
    spec.dependency "React-Core"
  end
end
