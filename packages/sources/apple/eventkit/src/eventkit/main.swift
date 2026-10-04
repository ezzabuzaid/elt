import Foundation

// Reads EventKit for the Calendar and Reminders sources.
//   eventkit read '<request json>'   one JSON document per stdout line
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

func readStore(_ request: ReadRequest) throws {
  let store = try openStore(request.entity)
  let lines = Lines()
  switch request.entity {
  case .events: try readEvents(request, store: store, lines: lines)
  case .reminders: try readReminders(request, store: store, lines: lines)
  }
  lines.flush()
  try requireAccess(request.entity, message: "access was revoked during execution")
}
