import type { RecordDraft } from '@workspace/elt';
import type { SafariWindow } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';
import { windowState, windowStateFields } from '../window-state.ts';

const { nullableId, nullableText } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Window UUID; tabs.windowId, windowTabGroups.windowId and windowProfiles.windowId refer to it.',
  },
  profileId: {
    ...nullableId,
    description:
      'The profile the window shows; refers to profiles.id. NULL when not recorded.',
  },
  activeTabGroupId: {
    ...nullableId,
    description: 'The tab group the window shows; refers to tabGroups.id.',
  },
  localTabGroupId: {
    ...nullableId,
    description:
      'The window own unnamed tab group of ordinary tabs; refers to tabGroups.id.',
  },
  privateTabGroupId: {
    ...nullableId,
    description:
      'The window own group of private tabs; refers to tabGroups.id.',
  },
  lastSession: {
    ...safariFields.boolean,
    description: 'Whether the window belongs to the last saved session.',
  },
  sceneId: {
    ...nullableText,
    description: 'Scene identifier of the window; NULL when not recorded.',
  },
  ...windowStateFields,
} as const;

export class WindowsStream extends SafariStream<
  typeof properties,
  SafariWindow
> {
  readonly name = 'windows';
  readonly store = 'tabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Safari window in the saved session (SafariTabs.db windows), with its state as Safari last saved it. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly SafariWindow[] {
    return scan.tabs.windows;
  }

  protected record(window: SafariWindow): RecordDraft<typeof properties> {
    return {
      id: window.id,
      profileId: window.profileId,
      activeTabGroupId: window.activeTabGroupId,
      localTabGroupId: window.localTabGroupId,
      privateTabGroupId: window.privateTabGroupId,
      lastSession: window.lastSession,
      sceneId: window.sceneId,
      ...windowState(window.state),
      closedAt: iso(window.closedAt),
    };
  }
}
