import EventKit
import Foundation

struct OccurrenceDocument: Encodable {
  let type = "occurrence"
  let calendarId: String
  let calendarItemId: String
  let externalId: String?
  let nativeEventId: String?
  let name: String?
  let body: String?
  let location: String?
  let url: String?
  let startMs: Double
  let endMs: Double
  let startDay: String
  let endDay: String
  let allDay: Bool
  let timeZone: String?
  let createdMs: Double?
  let modifiedMs: Double?
  let occurrenceMs: Double?
  let occurrenceDay: String?
  let detached: Bool
  let status: Int
  let availability: Int
  let birthdayContactId: String?
  let place: LocationDocument?
  let organizer: ParticipantDocument?
  let attendees: [ParticipantDocument]
  let alarms: [AlarmDocument]
  let recurrenceRules: [RecurrenceRuleDocument]

  init(_ event: EKEvent, calendarId: String) {
    self.calendarId = calendarId
    calendarItemId = event.calendarItemIdentifier
    externalId = event.calendarItemExternalIdentifier
    nativeEventId = event.eventIdentifier
    name = event.title
    body = event.notes
    location = event.location
    url = event.url?.absoluteString
    startMs = milliseconds(event.startDate)
    endMs = milliseconds(event.endDate)
    startDay = day(event.startDate)
    endDay = day(event.endDate)
    allDay = event.isAllDay
    timeZone = event.timeZone?.identifier
    createdMs = event.creationDate.map(milliseconds)
    modifiedMs = event.lastModifiedDate.map(milliseconds)
    occurrenceMs = event.occurrenceDate.map(milliseconds)
    occurrenceDay = event.occurrenceDate.map(day)
    detached = event.isDetached
    status = event.status.rawValue
    availability = event.availability.rawValue
    birthdayContactId = event.birthdayContactIdentifier
    place = LocationDocument(event.structuredLocation)
    organizer = event.organizer.map(ParticipantDocument.init)
    attendees = (event.attendees ?? []).map(ParticipantDocument.init)
    alarms = (event.alarms ?? []).map(AlarmDocument.init)
    recurrenceRules = (event.recurrenceRules ?? []).map(RecurrenceRuleDocument.init)
  }
}

struct IcsDocument: Encodable {
  let type = "ics"
  let calendarId: String
  let calendarItemId: String
  let recurring: Bool
  // Base64 iCalendar export of the native item, series included.
  let ics: String
}

// EventKit silently truncates queries longer than four years, so the interval
// is read in one-year windows. An event overlapping several windows is written
// once per window; Node keeps the first.
private let windowMs: Int64 = 365 * 24 * 60 * 60 * 1000

func readEvents(_ request: ReadRequest, store: EKEventStore, lines: Lines) throws {
  guard let startAt = request.startAt.flatMap(epochMs), let endAt = request.endAt.flatMap(epochMs),
    startAt < endAt
  else { throw HelperError("Calendar requires canonical UTC startAt < endAt timestamps") }
  let calendars = try writeAccountsAndCalendars(request, store: store, lines: lines, notes: notes)
  if calendars.isEmpty { return }
  let export = request.ics == true ? try IcsExport(store) : nil
  var exported = Set<[String]>()
  var windowStart = startAt
  while windowStart < endAt {
    let windowEnd = min(windowStart + windowMs, endAt)
    let rangeStart = Date(timeIntervalSince1970: Double(windowStart) / 1000)
    let rangeEnd = Date(timeIntervalSince1970: Double(windowEnd) / 1000)
    let predicate = store.predicateForEvents(withStart: rangeStart, end: rangeEnd, calendars: calendars)
    for event in store.events(matching: predicate)
    where overlaps(event, milliseconds(rangeStart), milliseconds(rangeEnd)) {
      guard let calendarId = event.calendar?.calendarIdentifier, !event.calendarItemIdentifier.isEmpty
      else { throw HelperError("EventKit event has no calendar or item identifier") }
      try lines.write(OccurrenceDocument(event, calendarId: calendarId))
      if let export, exported.insert([calendarId, event.calendarItemIdentifier]).inserted {
        try lines.write(try export.document(event, calendarId: calendarId))
      }
    }
    windowStart = windowEnd
  }
}

private func epochMs(_ timestamp: String) -> Int64? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: timestamp).map { Int64(milliseconds($0).rounded()) }
}

// A zero-duration event must start inside the window; others must overlap it.
private func overlaps(_ event: EKEvent, _ startMs: Double, _ endMs: Double) -> Bool {
  let start = milliseconds(event.startDate)
  let end = milliseconds(event.endDate)
  return start == end ? start >= startMs && start < endMs : start < endMs && end > startMs
}

// Calendar.app shows EKCalendar's private notes as the calendar description.
private func notes(_ calendar: EKCalendar) throws -> String? {
  guard calendar.responds(to: NSSelectorFromString("notes")) else {
    throw HelperError("EKCalendar has no notes on this macOS version, so Calendar descriptions cannot be read")
  }
  return calendar.value(forKey: "notes") as? String
}

// The ICS export is private EventKit API: detect it, and fail rather than
// return nothing when it is missing or produces no data.
private struct IcsExport {
  private typealias Folding = @convention(c) (AnyObject, Selector, NSArray, Bool) -> NSData?
  private typealias Options = @convention(c) (AnyObject, Selector, NSArray, UInt) -> NSData?
  private let store: EKEventStore
  private let export: ([EKCalendarItem]) -> NSData?

  init(_ store: EKEventStore) throws {
    self.store = store
    let folding = NSSelectorFromString("ICSDataForCalendarItems:preventLineFolding:")
    let options = NSSelectorFromString("ICSDataForCalendarItems:options:")
    if store.responds(to: folding) {
      let call = unsafeBitCast(store.method(for: folding), to: Folding.self)
      export = { call(store, folding, $0 as NSArray, true) }
    } else if store.responds(to: options) {
      let call = unsafeBitCast(store.method(for: options), to: Options.self)
      export = { call(store, options, $0 as NSArray, 0) }
    } else {
      throw HelperError("CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version")
    }
  }

  func document(_ event: EKEvent, calendarId: String) throws -> IcsDocument {
    let itemId = event.calendarItemIdentifier
    guard let item = store.calendarItem(withIdentifier: itemId) else {
      throw HelperError("EventKit could not resolve the calendar item for ICS export")
    }
    guard let data = export([item]), data.length > 0 else {
      throw HelperError("EventKit ICS export returned no data for \(itemId)")
    }
    return IcsDocument(
      calendarId: calendarId,
      calendarItemId: itemId,
      recurring: !(event.recurrenceRules ?? []).isEmpty || event.isDetached,
      ics: data.base64EncodedString()
    )
  }
}
