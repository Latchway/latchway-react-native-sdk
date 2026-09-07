# Idempotent native host setup. Public configuration only; no signing material.
require 'xcodeproj'
project = Xcodeproj::Project.open(File.join(__dir__, '../ios/LatchwayChat.xcodeproj'))
target = project.targets.find { |item| item.name == 'LatchwayChat' }
group = project.main_group.find_subpath('LatchwayChat')
%w[GoogleService-Info.plist Proof.m].each do |name|
  ref = group.files.find { |file| file.path == "LatchwayChat/#{name}" } ||
    group.new_file("LatchwayChat/#{name}")
  phase = name.end_with?('.m') ? target.source_build_phase : target.resources_build_phase
  phase.add_file_reference(ref) unless phase.files_references.include?(ref)
end
target.build_configurations.each do |build|
  build.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'dev.latchway'
  build.build_settings['DEVELOPMENT_TEAM'] = ENV.fetch('LATCHWAY_APPLE_TEAM_ID', '')
  build.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
  build.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'LatchwayChat/LatchwayChat.entitlements'
  build.build_settings['LATCHWAY_APP_ATTEST_ENVIRONMENT'] = build.name == 'Debug' ? 'development' : 'production'
end
project.save
