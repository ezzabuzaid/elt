// A store that an SDK reads: the name its errors give it, and what the user
// does when the store cannot be read (empty when nothing helps).
export class Store {
  readonly name: string;
  readonly remedy: string;

  constructor(name: string, remedy: string) {
    this.name = name;
    this.remedy = remedy;
  }
}
