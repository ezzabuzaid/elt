import type { Fields } from './fields.ts';
import type { TeamsMeeting } from './teams-client.ts';

// A calendar event the client holds, from a span around today that the
// calendar service chooses and does not record.
export function readMeeting(event: Fields): TeamsMeeting {
  return {
    id: event.requiredString('objectId'),
    iCalUid: event.string('iCalUID'),
    seriesMasterId: event.string('seriesMasterId'),
    eventType: event.string('eventType'),
    subject: event.string('subject'),
    startAt: event.requiredDate('startTime'),
    endAt: event.requiredDate('endTime'),
    timeZone: event.string('eventTimeZone'),
    location: event.string('location'),
    organizerName: event.string('organizerName'),
    organizerAddress: event.string('organizerAddress'),
    isOnlineMeeting: event.boolean('isOnlineMeeting'),
    joinUrl: event.string('skypeTeamsMeetingUrl'),
    // The meeting's chat (TeamsConversation.id).
    conversationId: event.object('skypeTeamsDataObject')?.string('cid') ?? null,
    myResponse: event.string('myResponseType'),
    showAs: event.string('showAs'),
    isCancelled: event.boolean('isCancelled') ?? false,
    bodyPreview: event.string('bodyPreview'),
    modifiedAt: event.instant('lastModifiedTime', 7),
    attendees: event.list('attendees').map((attendee) => ({
      address: attendee.requiredString('address'),
      name: attendee.string('name'),
      type: attendee.string('type'),
      role: attendee.string('role'),
      response: attendee.object('status')?.string('response') ?? null,
    })),
  };
}
