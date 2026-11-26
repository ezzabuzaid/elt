import EventKit
import Foundation

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

enum Entity: String, Decodable {
  case events, reminders

  init(argument: String) throws {
    guard let entity = Entity(rawValue: argument) else {
      throw HelperError("Unknown EventKit entity: \(argument)")
    }
    self = entity
  }

  var type: EKEntityType { self == .events ? .event : .reminder }

  // Node maps stderr containing the marker to CalendarUnavailableError or RemindersUnavailableError.
  var marker: String { self == .events ? "CALENDAR_UNAVAILABLE" : "REMINDERS_UNAVAILABLE" }
}

private func authorization(_ entity: Entity) -> EKAuthorizationStatus {
  EKEventStore.authorizationStatus(for: entity.type)
}

func requireAccess(_ entity: Entity, message: String) throws {
  guard authorization(entity) == .fullAccess else {
    throw HelperError("\(entity.marker): \(message); status=\(authorization(entity).rawValue)")
  }
}

// The helper only reads: when access is missing, the status in its error tells
// the Node store whether macOS can still ask (@zukhruf/tcc's request).
func openStore(_ entity: Entity) throws -> EKEventStore {
  try requireAccess(entity, message: "full access is required")
  return EKEventStore()
}

struct ReadRequest: Decodable {
  let entity: Entity
  // Write only the accounts and calendars, without their items or a window.
  let collectionsOnly: Bool?
  // Calendar's requested UTC interval, as canonical ISO timestamps.
  let startAt: String?
  let endAt: String?
  // Export each selected event item's iCalendar data (private EventKit API).
  let ics: Bool?
  let accountIds: [String]?
  let collectionIds: [String]?

  var scoped: Bool { accountIds != nil || collectionIds != nil }

  func selects(_ calendar: EKCalendar) -> Bool {
    (accountIds.map { $0.contains(calendar.source?.sourceIdentifier ?? "") } ?? true)
      && (collectionIds.map { $0.contains(calendar.calendarIdentifier) } ?? true)
  }
}

// Buffers NDJSON documents and writes them to stdout in 1 MiB chunks.
final class Lines {
  private let encoder = JSONEncoder()
  private var buffer = Data()

  func write<Document: Encodable>(_ document: Document) throws {
    buffer.append(try encoder.encode(document))
    buffer.append(0x0A)
    if buffer.count >= 1 << 20 { flush() }
  }

  func flush() {
    FileHandle.standardOutput.write(buffer)
    buffer.removeAll(keepingCapacity: true)
  }
}
