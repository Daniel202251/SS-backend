const HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

interface RequestMetricLabels {
  method: string;
  route: string;
  statusClass: string;
}

interface HistogramMetric {
  labels: RequestMetricLabels;
  bucketCounts: number[];
  count: number;
  sum: number;
}

interface CounterMetric {
  labels: RequestMetricLabels;
  value: number;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function buildLabelSet(labels: RequestMetricLabels): string {
  return `method="${escapeLabelValue(labels.method)}",route="${escapeLabelValue(
    labels.route
  )}",status_class="${escapeLabelValue(labels.statusClass)}"`;
}

function buildMetricKey(labels: RequestMetricLabels): string {
  return `${labels.method}|${labels.route}|${labels.statusClass}`;
}

export class MetricsRegistry {
  private readonly requestCounters = new Map<string, CounterMetric>();
  private readonly requestDurationHistograms = new Map<string, HistogramMetric>();
  private readonly customCounters = new Map<string, number>();

  recordHttpRequest(input: RequestMetricLabels & { durationMs: number }): void {
    const labels: RequestMetricLabels = {
      method: input.method,
      route: input.route,
      statusClass: input.statusClass,
    };
    const key = buildMetricKey(labels);
    const requestCounter = this.requestCounters.get(key) ?? {
      labels,
      value: 0,
    };

    requestCounter.value += 1;
    this.requestCounters.set(key, requestCounter);

    const histogram = this.requestDurationHistograms.get(key) ?? {
      labels,
      bucketCounts: HTTP_DURATION_BUCKETS_MS.map(() => 0),
      count: 0,
      sum: 0,
    };

    histogram.count += 1;
    histogram.sum += input.durationMs;

    for (let index = 0; index < HTTP_DURATION_BUCKETS_MS.length; index += 1) {
      if (input.durationMs <= HTTP_DURATION_BUCKETS_MS[index]) {
        histogram.bucketCounts[index] += 1;
        break;
      }
    }

    this.requestDurationHistograms.set(key, histogram);
  }

  renderPrometheusMetrics(): string {
    const lines = [
      "# HELP stellarsettle_http_requests_total Total completed HTTP requests.",
      "# TYPE stellarsettle_http_requests_total counter",
    ];

    for (const metric of this.requestCounters.values()) {
      lines.push(
        `stellarsettle_http_requests_total{${buildLabelSet(metric.labels)}} ${metric.value}`
      );
    }

    lines.push(
      "# HELP stellarsettle_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE stellarsettle_http_request_duration_ms histogram"
    );

    for (const metric of this.requestDurationHistograms.values()) {
      let cumulativeCount = 0;

      for (let index = 0; index < HTTP_DURATION_BUCKETS_MS.length; index += 1) {
        cumulativeCount += metric.bucketCounts[index];
        lines.push(
          `stellarsettle_http_request_duration_ms_bucket{${buildLabelSet(
            metric.labels
          )},le="${HTTP_DURATION_BUCKETS_MS[index]}"} ${cumulativeCount}`
        );
      }

      lines.push(
        `stellarsettle_http_request_duration_ms_bucket{${buildLabelSet(
          metric.labels
        )},le="+Inf"} ${metric.count}`,
        `stellarsettle_http_request_duration_ms_sum{${buildLabelSet(metric.labels)}} ${metric.sum}`,
        `stellarsettle_http_request_duration_ms_count{${buildLabelSet(metric.labels)}} ${metric.count}`
      );
    }

    for (const [key, value] of this.customCounters.entries()) {
      lines.push(
        `# HELP ${key}_total Custom counter.`,
        `# TYPE ${key}_total counter`,
        `${key}_total ${value}`
      );
    }

    lines.push(
      "# HELP stellarsettle_process_uptime_seconds Process uptime in seconds.",
      "# TYPE stellarsettle_process_uptime_seconds gauge",
      `stellarsettle_process_uptime_seconds ${process.uptime()}`
    );

    return `${lines.join("\n")}\n`;
  }

  increment(name: string, labels?: Record<string, string>): void {
    const key = labels
      ? `${name}{${Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",")}}`
      : name;
    const current = this.customCounters.get(key) ?? 0;
    this.customCounters.set(key, current + 1);
  }
}

export function getMetricsContentType(): string {
  return PROMETHEUS_CONTENT_TYPE;
}
