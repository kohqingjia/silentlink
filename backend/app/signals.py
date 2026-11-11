import csv
import io
import statistics


def summarize(samples):
    times = [s['t'] for s in samples]
    deltas = [b - a for a, b in zip(times, times[1:])]
    median = statistics.median(deltas)
    return {
        'duration_s': times[-1] - times[0],
        'observed_rate_hz': (len(times) - 1) / (times[-1] - times[0]),
        'median_interval_s': median,
        'max_gap_s': max(deltas),
        'gap_count': sum(d > 2.5 * median for d in deltas),
        'gap_threshold_s': 2.5 * median,
    }


def csv_bytes(recording):
    stream = io.StringIO()
    fields = ['t', 'sensor_timestamp'] + [f'{v}_{axis}' for v in ('user_acceleration', 'rotation_rate', 'gravity', 'attitude') for axis in ('x', 'y', 'z')] + ['attitude_w']
    writer = csv.DictWriter(stream, fieldnames=fields)
    writer.writeheader()
    for sample in recording['samples']:
        row = {k: sample[k] for k in ('t', 'sensor_timestamp')}
        for v in ('user_acceleration', 'rotation_rate', 'gravity', 'attitude'):
            row.update({f'{v}_{axis}': value for axis, value in sample[v].items()})
        writer.writerow(row)
    return stream.getvalue().encode()
