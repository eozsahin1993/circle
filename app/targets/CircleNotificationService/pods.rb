# Evaluated inside this target's block in the generated Podfile — pod
# lines only, no target wrapper (see apple-targets-extension-loader).

# swift-sodium: XChaCha20-Poly1305, which CryptoKit doesn't have. Via a
# local renamed podspec — see SwiftSodium.podspec.json for why the
# upstream pod can't link inside a static-library target.
pod 'SwiftSodium', :podspec => '../targets/CircleNotificationService/SwiftSodium.podspec.json'
