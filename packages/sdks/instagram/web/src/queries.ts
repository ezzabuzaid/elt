// A persisted GraphQL query of instagram.com's web client: the name it sends,
// the document id the server knows it by, and the Relay provider values the
// client sends with every call of it, which the server requires. The ids are
// the ones the client sent on 2026-10-14; Instagram serves an id it rotated
// away from for a while, and answers an unknown one with an error.
export type PersistedQuery = {
  readonly name: string;
  readonly docId: string;
  readonly providers: Readonly<Record<string, boolean>>;
};

const shortDrama = { PolarisShortDramaEnabled: true };
const storiesLabel = { PolarisCommunityNoteStoriesLabelEnabled: true };

export const profileQuery: PersistedQuery = {
  name: 'PolarisProfilePageContentQuery',
  docId: '28036671149327607',
  providers: {
    PolarisCannesGuardianExperienceEnabled: true,
    PolarisCASB976ProfileEnabled: false,
    PolarisWebSchoolsEnabled: false,
    PolarisRepostsConsumptionEnabled: true,
    PolarisShortDramaEnabled: true,
  },
};

export const postsQuery: PersistedQuery = {
  name: 'PolarisProfilePostsTabContentQuery_connection',
  docId: '39229011733413759',
  providers: {
    PolarisMultiCaptionCarouselEnabled: true,
    PolarisShortDramaEnabled: true,
    PolarisThreadsStyleCommentsEnabled: false,
    PolarisReelsRecoDebugOverlayEnabled: false,
  },
};

export const reelsQuery: PersistedQuery = {
  name: 'PolarisProfileReelsTabContentQuery_connection',
  docId: '28728438306809751',
  providers: shortDrama,
};

export const repostsQuery: PersistedQuery = {
  name: 'PolarisProfileRepostsTabContentQuery',
  docId: '28594321130221951',
  providers: shortDrama,
};

export const moreRepostsQuery: PersistedQuery = {
  name: 'PolarisProfileRepostsTabContentRefetchQuery',
  docId: '28844503865240264',
  providers: shortDrama,
};

export const taggedQuery: PersistedQuery = {
  name: 'PolarisProfileTaggedTabContentQuery_connection',
  docId: '28712186505109571',
  providers: shortDrama,
};

export const highlightsQuery: PersistedQuery = {
  name: 'PolarisProfileStoryHighlightsTrayContentQuery',
  docId: '26970053832668570',
  providers: {},
};

export const storiesQuery: PersistedQuery = {
  name: 'PolarisStoriesV3HighlightsPageQuery',
  docId: '39400183649572570',
  providers: storiesLabel,
};

export const highlightItemsQuery: PersistedQuery = {
  name: 'PolarisStoriesV3HighlightsPagePaginationQuery',
  docId: '28808391232182823',
  providers: storiesLabel,
};

// The variables the client sends: the query's own, then its providers.
export function variablesOf(
  query: PersistedQuery,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...variables,
    ...Object.fromEntries(
      Object.entries(query.providers).map(([provider, value]) => [
        `__relay_internal__pv__${provider}relayprovider`,
        value,
      ]),
    ),
  };
}
