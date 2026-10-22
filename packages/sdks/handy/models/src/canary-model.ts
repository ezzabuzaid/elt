import { HandyModel } from './handy-model.ts';

export class CanaryModel extends HandyModel {
  readonly id = 'canary-180m-flash';
  readonly title = 'Canary';
  readonly engine = 'canary';
  protected readonly files = [
    'encoder-model.int8.onnx',
    'decoder-model.int8.onnx',
    'nemo128.onnx',
    'vocab.txt',
    'config.json',
  ];
}
