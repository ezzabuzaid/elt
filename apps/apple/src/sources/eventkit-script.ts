export const eventKitScript = `
const eventKit = (() => {
  const isNil = (value) =>
    value === null ||
    value === undefined ||
    (typeof value.isNil === 'function' && value.isNil()) ||
    (typeof value.isKindOfClass === 'function' && value.isKindOfClass($.NSNull));
  const array = (value) => {
    if (isNil(value)) return [];
    if (!Number.isSafeInteger(Number(value.count)) || Number(value.count) < 0)
      throw new Error('EventKit returned an invalid collection');
    const result = [];
    for (let index = 0; index < Number(value.count); index += 1)
      result.push(value.objectAtIndex(index));
    return result;
  };
  const string = (value) => (isNil(value) ? null : ObjC.unwrap(value));
  const number = (value) => {
    if (isNil(value)) return null;
    const result = Number(ObjC.unwrap(value));
    if (!Number.isFinite(result)) throw new Error('EventKit returned a non-finite number');
    return result;
  };
  const integer = (value) => {
    const result = number(value);
    if (result === null || Number.isInteger(result)) return result;
    throw new Error('EventKit returned a non-integer value');
  };
  const bool = (value) => {
    if (typeof value !== 'boolean') throw new Error('EventKit returned an invalid boolean');
    return value;
  };
  const nativeDate = (value) => {
    if (typeof value !== 'string')
      throw new Error('Calendar range must use ISO timestamps');
    const valueMs = Date.parse(value);
    if (!Number.isFinite(valueMs)) throw new Error('Calendar range contains an invalid timestamp');
    return $.NSDate.dateWithTimeIntervalSince1970(valueMs / 1000);
  };
  const milliseconds = (value) => {
    if (isNil(value)) return null;
    const result = Number(value.timeIntervalSince1970) * 1000;
    if (!Number.isFinite(result)) throw new Error('EventKit returned an invalid date');
    return result;
  };
  const timestamp = (value) => {
    const valueMs = milliseconds(value);
    return valueMs === null ? null : new Date(valueMs).toISOString();
  };
  const dateFormatter = $.NSDateFormatter.alloc.init;
  dateFormatter.locale = $.NSLocale.localeWithLocaleIdentifier('en_US_POSIX');
  dateFormatter.calendar = $.NSCalendar.alloc.initWithCalendarIdentifier(
    'gregorian',
  );
  dateFormatter.timeZone = $.NSTimeZone.defaultTimeZone;
  dateFormatter.dateFormat = 'yyyy-MM-dd';
  const dateOnly = (value) => {
    dateFormatter.timeZone = $.NSTimeZone.defaultTimeZone;
    return isNil(value) ? null : ObjC.unwrap(dateFormatter.stringFromDate(value));
  };
  const url = (value) => (isNil(value) ? null : string(value.absoluteString));
  const location = (value) => {
    if (isNil(value))
      return { title: null, latitude: null, longitude: null, radius: null };
    const geoLocation = value.geoLocation;
    const coordinate = isNil(geoLocation) ? null : geoLocation.coordinate;
    return {
      title: string(value.title),
      latitude: coordinate === null ? null : number(coordinate.latitude),
      longitude: coordinate === null ? null : number(coordinate.longitude),
      radius: number(value.radius),
    };
  };
  const colorComponent = (value) => {
    const result = number(value);
    if (result === null || (result >= 0 && result <= 1)) return result;
    throw new Error('EventKit returned an out-of-range color component');
  };
  const color = (value) => {
    if (isNil(value)) return [null, null, null, null];
    const rgb = value.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
    if (isNil(rgb)) throw new Error('EventKit calendar color cannot be converted to sRGB');
    return [
      colorComponent(rgb.redComponent),
      colorComponent(rgb.greenComponent),
      colorComponent(rgb.blueComponent),
      colorComponent(rgb.alphaComponent),
    ];
  };
  const participant = (itemId, ownerKey, value, kind, position) => ({
    id: JSON.stringify([itemId, kind, position]),
    [ownerKey]: itemId,
    position,
    kind,
    name: string(value.name),
    url: url(value.URL),
    status: number(value.participantStatus),
    role: number(value.participantRole),
    type: number(value.participantType),
    isCurrentUser: bool(value.isCurrentUser),
  });
  const ruleValue = (itemId, ownerKey, ruleId, component, position, value, weekNumber) => ({
    id: JSON.stringify([ruleId, component, position]),
    [ownerKey]: itemId,
    ruleId,
    component,
    position,
    value: integer(value),
    weekNumber,
  });

  const accounts = (store) => {
    const records = [];
    if (isNil(store.sources)) throw new Error('EventKit account query failed');
    for (const source of array(store.sources))
      records.push({
        id: string(source.sourceIdentifier),
        name: string(source.title),
        type: number(source.sourceType),
        isDelegate: bool(source.isDelegate),
      });
    return records;
  };
  const calendars = (store, entityType) => {
    const records = [];
    const calendars = store.calendarsForEntityType(entityType);
    if (isNil(calendars)) throw new Error('EventKit calendar query failed');
    for (const calendar of array(calendars)) {
      const rgba = color(calendar.color);
      records.push({
        id: string(calendar.calendarIdentifier),
        accountId: string(isNil(calendar.source) ? null : calendar.source.sourceIdentifier),
        name: string(calendar.title),
        type: number(calendar.type),
        writable: bool(calendar.allowsContentModifications),
        subscribed: bool(calendar.isSubscribed),
        immutable: bool(calendar.isImmutable),
        colorRed: rgba[0],
        colorGreen: rgba[1],
        colorBlue: rgba[2],
        colorAlpha: rgba[3],
        supportedAvailabilities: number(calendar.supportedEventAvailabilities),
        allowedEntityTypes: number(calendar.allowedEntityTypes),
      });
    }

    return records;
  };
  // EventKit returns an item's attendees and alarms in a different order in
  // each process (verified live), so positions follow their content instead.
  const inContentOrder = (values, key) =>
    values
      .map((value) => [JSON.stringify(key(value)), value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value);
  const related = (item, itemId, ownerKey, stream) => {
    if (!['attendees', 'alarms', 'recurrenceRules', 'recurrenceRuleValues'].includes(stream)) return [];
    const wants = name => name === stream;
    const records = [];
    const emit = (name, row) => { if (wants(name)) records.push(row); };
    const rules = array(item.recurrenceRules);
    if (wants('attendees')) {
      if (ownerKey === 'eventId' && !isNil(item.organizer))
        records.push(participant(itemId, ownerKey, item.organizer, 'organizer', 0));
      // A reply changes status, so status does not order attendees.
      const attendees = inContentOrder(array(item.attendees), (value) => [
        url(value.URL),
        string(value.name),
        number(value.participantRole),
        number(value.participantType),
      ]);
      for (const [position, value] of attendees.entries())
        records.push(participant(itemId, ownerKey, value, 'attendee', position));
    }
    if (wants('alarms')) {
      const alarms = inContentOrder(
        array(item.alarms).map((alarm) => {
          const alarmLocation = location(alarm.structuredLocation);
          return {
            type: number(alarm.type),
            relativeOffset: number(alarm.relativeOffset),
            absoluteAt: timestamp(alarm.absoluteDate),
            emailAddress: string(alarm.emailAddress),
            soundName: string(alarm.soundName),
            proximity: number(alarm.proximity),
            locationTitle: alarmLocation.title,
            latitude: alarmLocation.latitude,
            longitude: alarmLocation.longitude,
            radius: alarmLocation.radius,
          };
        }),
        (alarm) => Object.values(alarm),
      );
      for (const [position, alarm] of alarms.entries())
        emit('alarms', {
          id: JSON.stringify([itemId, position]),
          [ownerKey]: itemId,
          position,
          ...alarm,
        });
    }

    if (wants('recurrenceRules') || wants('recurrenceRuleValues'))
      for (const [position, rule] of rules.entries()) {
        const ruleId = JSON.stringify([itemId, 'recurrenceRule', position]);
        if (wants('recurrenceRules')) {
          const recurrenceEnd = rule.recurrenceEnd;
          emit('recurrenceRules', {
            id: ruleId,
            [ownerKey]: itemId,
            position,
            calendarIdentifier: string(rule.calendarIdentifier),
            frequency: number(rule.frequency),
            interval: number(rule.interval),
            firstDayOfWeek: number(rule.firstDayOfTheWeek),
            endAt: isNil(recurrenceEnd) ? null : timestamp(recurrenceEnd.endDate),
            occurrenceCount: isNil(recurrenceEnd)
              ? 0
              : number(recurrenceEnd.occurrenceCount),
          });
        }
        if (!wants('recurrenceRuleValues')) continue;
        for (const [index, day] of array(rule.daysOfTheWeek).entries())
          emit(
            'recurrenceRuleValues',
            ruleValue(
              itemId,
              ownerKey,
              ruleId,
              'daysOfTheWeek',
              index,
              day.dayOfTheWeek,
              integer(day.weekNumber),
            ),
          );
        for (const component of [
          'daysOfTheMonth',
          'daysOfTheYear',
          'weeksOfTheYear',
          'monthsOfTheYear',
          'setPositions',
        ])
          for (const [index, value] of array(rule[component]).entries())
            emit(
              'recurrenceRuleValues',
              ruleValue(itemId, ownerKey, ruleId, component, index, value, null),
            );
      }
    return records;
  };
  return { isNil, array, string, number, integer, bool, nativeDate, milliseconds,
    timestamp, dateOnly, url, location, accounts, calendars, related };
})();
`;
