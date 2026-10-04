import EventKit
import Foundation

// Writes "changed" for each EKEventStoreChanged notification until the parent
// kills the process. The first line only confirms the subscription.
func watch(_ entity: Entity) throws {
  let store = try openStore(entity)
  let changed = { FileHandle.standardOutput.write(Data("changed\n".utf8)) }
  let observer = NotificationCenter.default.addObserver(
    forName: .EKEventStoreChanged, object: store, queue: .main
  ) { _ in changed() }
  defer { NotificationCenter.default.removeObserver(observer) }
  changed()
  RunLoop.main.run()
}
