import { type KnowledgeRow, KnowledgeStream } from '../knowledge-stream.ts';
import { flag } from '../knowledge-values.ts';

export type DisplayIsBacklitEvent = {
  readonly backlit: boolean | undefined;
};

// A span the display stayed lit or dark.
export class DisplayIsBacklit extends KnowledgeStream<DisplayIsBacklitEvent> {
  readonly name = '/display/isBacklit';
  readonly maximumAgeDays = 28;
  readonly columns = { ZOBJECT: ['ZVALUEINTEGER'] };

  decode(row: KnowledgeRow): DisplayIsBacklitEvent {
    return { backlit: flag(row.ZVALUEINTEGER) };
  }
}
