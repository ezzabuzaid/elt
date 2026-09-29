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

// The macOS 14 authorization values: 0 undetermined, 1 restricted, 2 denied,
// 3 full access, 4 write-only.
private func authorization(_ entity: Entity) -> Int {
  EKEventStore.authorizationStatus(for: entity.type).rawValue
}

func requireAccess(_ entity: Entity, message: String) throws {
  guard authorization(entity) == 3 else {
    throw HelperError("\(entity.marker): \(message); status=\(authorization(entity))")
  }
}

// Asks for full access when it was never decided or only write access was granted,
// then waits up to 30 seconds for the answer.
func openStore(_ entity: Entity) throws -> EKEventStore {
  guard #available(macOS 14, *) else {
    throw HelperError("\(entity.marker): macOS 14 or later is required")
  }
  let store = EKEventStore()
  let undecided = { [0, 4].contains(authorization(entity)) }
  if undecided() {
    switch entity {
    case .events: store.requestFullAccessToEvents { _, _ in }
    case .reminders: store.requestFullAccessToReminders { _, _ in }
    }
    let deadline = Date(timeIntervalSinceNow: 30)
    while undecided() && Date() < deadline {
      RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
  }
  try requireAccess(entity, message: "full access is required")
  return store
}

struct ReadRequest: Decodable {
  let entity: Entity
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
