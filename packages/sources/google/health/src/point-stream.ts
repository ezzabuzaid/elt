import type { RecordMessage } from '@workspace/elt';
import type { DataPoint, ListedDataType } from '@workspace/sdk-google-health';

import type { GoogleHealthScan } from './google-health-scan.ts';
import {
  GoogleHealthStream,
  type StreamDefinition,
} from './google-health-stream.ts';
import { fields } from './health-fields.ts';

export type PointStreamDefinition = Omit<StreamDefinition, 'primaryKey'> & {
  readonly type: ListedDataType;
  /**
   * The type's points carry a resource name, its one stable id; Google gives
   * one only to types a user can edit or delete.
   */
  readonly named: boolean;
  /** Child streams read the same points, so this run fetches them once. */
  readonly shared: boolean;
};

const origin = {
  platform: {
    ...fields.text,
    description:
      'Where the point came from: FITBIT for Fitbit and Pixel devices and the Google Health app, HEALTH_KIT for Apple Health (an Apple Watch or iPhone, relayed by the Google Health iPhone app), HEALTH_CONNECT for Android Health Connect, and others Google names.',
  },
  recordingMethod: {
    ...fields.text,
    description:
      'How the point was recorded: MANUAL, PASSIVELY_MEASURED, ACTIVELY_MEASURED, DERIVED or UNKNOWN.',
  },
  deviceDisplayName: {
    ...fields.text,
    description:
      'The name of the device that recorded the point, when Google keeps one.',
  },
  deviceFormFactor: {
    ...fields.text,
    description:
      'The kind of device that recorded the point: FITNESS_BAND, WATCH, PHONE, RING, CHEST_STRAP, SCALE, TABLET, HEAD_MOUNTED or SMART_DISPLAY.',
  },
  deviceManufacturer: {
    ...fields.text,
    description: 'The device maker, such as Apple Inc. for an Apple Watch.',
  },
  applicationPackageName: {
    ...fields.text,
    description:
      'The app that wrote the point: its Android package name, or com.apple.health.<id> for Apple Health.',
  },
  applicationWebClientId: {
    ...fields.text,
    description: 'The web client that wrote the point, when one did.',
  },
  applicationGoogleWebClientId: {
    ...fields.text,
    description: 'The Google web client that wrote the point, when one did.',
  },
} as const;

/**
 * The points of one data type, one record each. A type a user can edit is
 * keyed by its resource name; a measured type has no id Google keeps, so its
 * stream declares no key.
 */
export abstract class PointStream extends GoogleHealthStream {
  readonly type: ListedDataType;
  readonly #shared: boolean;

  constructor({
    type,
    named,
    shared,
    properties,
    ...definition
  }: PointStreamDefinition) {
    super({
      ...definition,
      properties: {
        name: named
          ? {
              type: 'string',
              minLength: 1,
              description:
                "The point's resource name, users/<id>/dataTypes/<type>/dataPoints/<id>: its id.",
            }
          : {
              ...fields.text,
              description:
                "The point's resource name when Google gives one; points of the measured types carried none on 2026-10-15.",
            },
        ...origin,
        ...properties,
      },
      ...(named && { primaryKey: ['name'] }),
    });
    this.type = type;
    this.#shared = shared;
  }

  async *extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage> {
    yield* this.records(this.#rows(scan, signal));
  }

  async *#rows(scan: GoogleHealthScan, signal: AbortSignal | undefined) {
    const points = this.#shared
      ? await scan.shared(this.type, signal)
      : scan.points(this.type, signal);
    for await (const point of points)
      yield {
        name: point.name ?? null,
        ...originOf(point),
        ...this.row(point),
      };
  }

  // The type's own columns of one point.
  protected abstract row(point: DataPoint): Record<string, unknown>;
}

function originOf({ dataSource }: DataPoint) {
  return {
    platform: dataSource?.platform ?? null,
    recordingMethod: dataSource?.recordingMethod ?? null,
    deviceDisplayName: dataSource?.device?.displayName ?? null,
    deviceFormFactor: dataSource?.device?.formFactor ?? null,
    deviceManufacturer: dataSource?.device?.manufacturer ?? null,
    applicationPackageName: dataSource?.application?.packageName ?? null,
    applicationWebClientId: dataSource?.application?.webClientId ?? null,
    applicationGoogleWebClientId:
      dataSource?.application?.googleWebClientId ?? null,
  };
}

/** The resource name of a point whose type Google names, which keys its children. */
export function nameOf(point: DataPoint): string {
  if (!point.name)
    throw new TypeError(
      'Google Health sent a point without the name its type always has',
    );
  return point.name;
}

/** A measured point's origin, which its children repeat since it has no id. */
export const pointOrigin = { properties: origin, row: originOf } as const;
