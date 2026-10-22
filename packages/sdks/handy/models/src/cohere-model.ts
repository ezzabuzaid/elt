import { HandyModel } from './handy-model.ts';

export class CohereModel extends HandyModel {
  readonly id = 'cohere-int8';
  readonly title = 'Cohere';
  readonly engine = 'cohere';
  protected readonly files = [
    'cohere-encoder.int8.onnx',
    'cohere-encoder.int8.onnx.data',
    'cohere-decoder.int8.onnx',
    'tokens.txt',
  ];
}
