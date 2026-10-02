export interface CircuitBreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

export interface CircuitBreakerState {
  failures: number;
  successes: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

export class CircuitBreaker {
  private state: CircuitBreakerState = {
    failures: 0,
    successes: 0,
    lastFailure: 0,
    state: "closed",
  };

  constructor(private readonly options: CircuitBreakerOptions) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state.state === "open") {
      if (Date.now() - this.state.lastFailure >= this.options.timeout) {
        this.state.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state.failures = 0;
    if (this.state.state === "half-open") {
      this.state.successes++;
      if (this.state.successes >= this.options.successThreshold) {
        this.state.state = "closed";
        this.state.successes = 0;
      }
    }
  }

  private onFailure(): void {
    this.state.failures++;
    this.state.lastFailure = Date.now();
    this.state.successes = 0;
    if (this.state.failures >= this.options.failureThreshold) {
      this.state.state = "open";
    }
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      failures: 0,
      successes: 0,
      lastFailure: 0,
      state: "closed",
    };
  }
}

export function createCircuitBreaker(options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: options?.failureThreshold ?? 5,
    successThreshold: options?.successThreshold ?? 2,
    timeout: options?.timeout ?? 30000,
  });
}
