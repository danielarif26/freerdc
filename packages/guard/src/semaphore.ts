export class Semaphore {
  private capacity: number;
  private active: number;
  private waiting: ((release: () => void) => void)[];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("Semaphore capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.active = 0;
    this.waiting = [];
  }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.drain();
    });
  }

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiting.length > 0) {
      const resolver = this.waiting.shift();
      if (resolver) {
        this.active++;
        let released = false;
        const releaseOnce = () => {
          if (!released) {
            released = true;
            this.active--;
            this.drain();
          }
        };
        resolver(releaseOnce);
      }
    }
  }
}
