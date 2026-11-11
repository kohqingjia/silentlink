"""Plot measured data only: python -m silentlink_ml.plot recording.json plot.png."""
import json
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from .pipeline import validate_recording


def main():
    with open(sys.argv[1]) as file:
        r = json.load(file)
    t, values = validate_recording(r)
    figure, axes = plt.subplots(2, 1, sharex=True, figsize=(10, 6))
    for index, label in enumerate(('User acceleration (g)', 'Rotation rate (rad/s)')):
        for axis in range(3):
            axes[index].plot(t, values[:, index * 3 + axis], label='XYZ'[axis], linewidth=.7)
        axes[index].set_ylabel(label)
        axes[index].legend()
    axes[-1].set_xlabel('Seconds from first sample')
    figure.suptitle(f'{r["label"]} · {r["id"][:8]} · measured samples')
    figure.tight_layout()
    figure.savefig(sys.argv[2], dpi=160)


if __name__ == '__main__':
    main()
