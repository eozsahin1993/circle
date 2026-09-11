import Foundation
import Security
import UserNotifications

let appGroup = "group.com.eozsahin.circle"

/// Hardcoded, never read from the payload: a push that can't be decrypted
/// must not choose its own lock-screen text.
let placeholder = "New activity"

class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler handler: @escaping (UNNotificationContent) -> Void
  ) {
    contentHandler = handler
    content = request.content.mutableCopy() as? UNMutableNotificationContent
    guard let content else {
      handler(request.content)
      return
    }

    content.title = ""
    content.body = placeholder
    if let composed = compose(userInfo: request.content.userInfo) {
      content.title = composed.title
      content.body = composed.body
      content.threadIdentifier = composed.circleId
    }
    handler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content {
      contentHandler(content)
    }
  }

  /// One decrypted, verified push — what composing a card needs.
  private struct DecryptedPush {
    let circle: SnapshotCircle
    let type: String
    let payload: [String: Any]?
    let authorPubkey: String
  }

  /// The native mirror of handle-push.ts's decrypt half. Nil for every
  /// failure — the placeholder stands.
  private func decrypt(userInfo: [AnyHashable: Any]) -> DecryptedPush? {
    guard let routingId = userInfo["pushRoutingId"] as? String,
          let payloadB64 = userInfo["payload"] as? String,
          let box = Data(base64Encoded: payloadB64),
          let keyVersion = keyVersion(from: userInfo["keyVersion"]),
          let (circle, key) = contentKey(routingId: routingId, keyVersion: keyVersion),
          let plaintext = CircleCrypto.open(box, key: key),
          let envelope = CircleCrypto.verifyEnvelope(plaintext),
          let type = envelope["type"] as? String,
          let authorPubkey = envelope["authorPubkey"] as? String
    else { return nil }
    return DecryptedPush(
      circle: circle,
      type: type,
      payload: envelope["payload"] as? [String: Any],
      authorPubkey: authorPubkey
    )
  }

  /// describeEntry in handle-push.ts. Nil for types that shouldn't raise
  /// a card — but iOS can't suppress a delivered alert, so the
  /// placeholder is the quietest outcome available.
  private func compose(userInfo: [AnyHashable: Any]) -> (title: String, body: String, circleId: String)? {
    guard let push = decrypt(userInfo: userInfo) else { return nil }

    let body: String
    switch push.type {
    case "member_added":
      // The author is the approving admin; the joiner's name is in the payload.
      let joined = push.payload?["name"] as? String
      body = "\((joined?.isEmpty == false ? joined : nil) ?? "Someone") joined"
    case "post", "comment", "reaction":
      let member = push.circle.members.first { $0.identityPublicKey == push.authorPubkey }
      let name = (member?.name.isEmpty == false ? member?.name : nil) ?? "Someone"
      // Mirrors describeEntry in handle-push.ts — the copy must match
      // whichever platform composes it.
      switch push.type {
      case "post": body = "\(name) added a photo"
      case "comment":
        let text = (push.payload?["body"] as? String).flatMap { $0.isEmpty ? nil : ": “\($0)”" } ?? ""
        if let postAuthor = push.payload?["postAuthorPubkey"] as? String {
          body = postAuthor == ownIdentityPubkey(circleId: push.circle.id)
            ? "\(name) commented on your photo\(text)"
            : "\(name) also commented\(text)"
        } else {
          body = "\(name) commented\(text)"
        }
      default:
        if let emoji = push.payload?["emoji"] as? String, !emoji.isEmpty {
          body = "\(name) reacted \(emoji) to your photo"
        } else {
          body = "\(name) reacted to your photo"
        }
      }
    default:
      return nil
    }

    return (title: push.circle.name, body: body, circleId: push.circle.id)
  }

  /// Everything this device holds that one push needs: which circle the
  /// routing id names (recomputed per circle, same as circleForRoutingId
  /// in handle-push.ts — there is no stored map, by design), and that
  /// circle's content key at the entry's version.
  private func contentKey(routingId: String, keyVersion: Int) -> (circle: SnapshotCircle, key: Data)? {
    guard let seedHex = readKeychain(account: "master_seed"),
          let seed = Data(hexString: seedHex),
          let circles = readSnapshot(),
          let circle = circles.first(where: {
            CircleCrypto.pushRoutingId(masterSeed: seed, circleId: $0.id) == routingId
          }),
          let keyMapJSON = readKeychain(account: "circle_keys_\(circle.id)"),
          let keyMap = (try? JSONSerialization.jsonObject(with: Data(keyMapJSON.utf8))) as? [String: String],
          let keyHex = keyMap[String(keyVersion)],
          let key = Data(hexString: keyHex)
    else { return nil }
    return (circle, key)
  }

  /// This device's own signing key for a circle, from the same shared
  /// keychain item keystore.ts writes (circle_identity_<circleId>).
  private func ownIdentityPubkey(circleId: String) -> String? {
    guard let json = readKeychain(account: "circle_identity_\(circleId)"),
          let record = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    else { return nil }
    return record["publicKey"] as? String
  }

  private func keyVersion(from value: Any?) -> Int? {
    if let number = value as? NSNumber { return number.intValue }
    if let string = value as? String { return Int(string) }
    return nil
  }

  /// Matches expo-secure-store's item shape (its SecureStoreModule.swift):
  /// generic password, service "app:no-auth", account = the key.
  /// keystore.ts writes into the shared group with these attributes.
  private func readKeychain(account: String) -> String? {
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: Data(account.utf8),
        kSecAttrAccessGroup as String: appGroup,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
        return String(data: data, encoding: .utf8)
      }
    }
    return nil
  }

  private struct Snapshot: Decodable { let circles: [SnapshotCircle] }
  private struct SnapshotCircle: Decodable {
    let id: String
    let name: String
    let members: [SnapshotMember]
  }
  private struct SnapshotMember: Decodable {
    let identityPublicKey: String
    let name: String
  }

  /// The circle/member names mirror written by push-snapshot.ts.
  private func readSnapshot() -> [SnapshotCircle]? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
          let data = try? Data(contentsOf: container.appendingPathComponent("push-snapshot.json")),
          let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
    else { return nil }
    return snapshot.circles
  }
}
