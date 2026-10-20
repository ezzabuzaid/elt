import EventKit
import Foundation

// Reads EventKit for the Calendar and Reminders sources.
//   eventkit read '<request json>'   one JSON document per stdout line; EVENTKIT_CHANGED when the store changed meanwhile
//   eventkit watch events|reminders  "changed" per store change; the first line confirms the subscription
// Failures go to stderr and exit 1; access failures carry the entity's marker.
let arguments = Array(CommandLine.arguments.dropFirst())
do {
  switch (arguments.first, arguments.dropFirst().first) {
  case ("read", let request?):
    try readStore(JSONDecoder().decode(ReadRequest.self, from: Data(request.utf8)))
  case ("watch", let entity?):
    try watch(Entity(argument: entity))
  default:
    throw HelperError("Usage: eventkit read <request> | eventkit watch events|reminders")
  }
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}

// EventKit has no read transaction, so a read fails with EVENTKIT_CHANGED when
// the store changed while it ran, and Node reads again. EventKit posts
// EKEventStoreChanged on the main run loop up to 250 ms after a change; the
// read blocks that loop while it fetches, so it runs the loop for 250 ms after.
func readStore(_ request: ReadRequest) throws {
  let store = try openStore(request.entity)
  var changed = false
  let observer = NotificationCenter.default.addObserver(
    forName: .EKEventStoreChanged, object: store, queue: .main
  ) { _ in changed = true }
  defer { NotificationCenter.default.removeObserver(observer) }
  let lines = Lines()
  switch request.entity {
  case .events: try readEvents(request, store: store, lines: lines)
  case .reminders: try readReminders(request, store: store, lines: lines)
  }
  lines.flush()
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.25))
  try requireAccess(request.entity, message: "access was revoked during execution")
  if changed { throw HelperError("EVENTKIT_CHANGED: the store changed during the read") }
}
