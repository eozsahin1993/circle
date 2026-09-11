import CryptoKit
import Foundation
import SwiftSodium

/// The receive half of app/src/services/crypto.ts, ported for the
/// extension's own process. push-crypto-vectors.test.ts pins the exact
/// bytes this must reproduce — check a change here against those.
enum CircleCrypto {
  /// derivePushRoutingId in crypto.ts. The domain string is
  /// "push-enabled", not PUSH_DESIGN.md's "push-routing" — the code won.
  static func pushRoutingId(masterSeed: Data, circleId: String) -> String {
    let info = Data("push-enabled".utf8) + Data(circleId.utf8)
    let key = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: masterSeed),
      salt: Data(),
      info: info,
      outputByteCount: 32
    )
    return key.withUnsafeBytes { Data($0).hexString }
  }

  private static let sodium = Sodium()

  /// decrypt in crypto.ts: nonce(24) || box, no AAD — libsodium's combined
  /// format as-is. CryptoKit has no XChaCha, hence the dependency.
  static func open(_ box: Data, key: Data) -> Data? {
    guard key.count == 32 else { return nil }
    guard let plaintext = sodium.aead.xchacha20poly1305ietf.decrypt(
      nonceAndAuthenticatedCipherText: [UInt8](box),
      secretKey: [UInt8](key)
    ) else { return nil }
    return Data(plaintext)
  }

  /// The signature covers JSON.stringify({type, payload}), and the
  /// envelope serializes those same values first — so the signed bytes are
  /// the plaintext up to its last `,"authorPubkey":"`, plus a closing
  /// brace. Extracted textually because Swift encoders can't reproduce JS
  /// key order. Nil for every way an envelope can be untrustworthy, same
  /// contract as verifyLogEntry in log-entry.ts.
  static func verifyEnvelope(_ plaintext: Data) -> [String: Any]? {
    guard let envelope = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
          envelope["type"] is String,
          let authorHex = envelope["authorPubkey"] as? String,
          let signatureHex = envelope["signature"] as? String,
          let author = Data(hexString: authorHex), author.count == 32,
          let signature = Data(hexString: signatureHex), signature.count == 64,
          let marker = plaintext.range(of: Data(",\"authorPubkey\":\"".utf8), options: .backwards)
    else { return nil }

    var message = plaintext.subdata(in: plaintext.startIndex..<marker.lowerBound)
    message.append(UInt8(ascii: "}"))

    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: author),
          key.isValidSignature(signature, for: message)
    else { return nil }
    return envelope
  }

}

extension Data {
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }

  init?(hexString: String) {
    guard hexString.count % 2 == 0 else { return nil }
    var bytes = [UInt8]()
    bytes.reserveCapacity(hexString.count / 2)
    var index = hexString.startIndex
    while index < hexString.endIndex {
      let next = hexString.index(index, offsetBy: 2)
      guard let byte = UInt8(hexString[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}
