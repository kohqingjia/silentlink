from typing import Annotated, Literal
from uuid import UUID
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

Finite = Annotated[float, Field(allow_inf_nan=False)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Vector(StrictModel):
    x: Finite
    y: Finite
    z: Finite


class Quaternion(Vector):
    w: Finite


class Sample(StrictModel):
    t: Annotated[Finite, Field(ge=0, le=600)]
    sensor_timestamp: Annotated[Finite, Field(ge=0)]
    user_acceleration: Vector
    rotation_rate: Vector
    gravity: Vector
    attitude: Quaternion


class Interruption(StrictModel):
    t: Annotated[Finite, Field(ge=0, le=660)]
    reason: str = Field(min_length=1, max_length=200)


class SessionIn(StrictModel):
    id: UUID
    experiment: str = Field(min_length=1, max_length=120)
    device: str = Field(min_length=1, max_length=128)
    started_at: AwareDatetime
    notes: str = Field(default='', max_length=2000)
    protocol_version: Literal['motion-v1'] = 'motion-v1'


class RecordingIn(StrictModel):
    schema_version: Literal[1] = 1
    id: UUID
    session_id: UUID
    label: str = Field(min_length=1, max_length=160)
    recording_type: Literal['motion'] = 'motion'
    source: Literal['cmheadphonemotionmanager'] = 'cmheadphonemotionmanager'
    synthetic: Literal[False] = False
    started_at: AwareDatetime
    device: str = Field(min_length=1, max_length=128)
    os_version: str = Field(max_length=80)
    requested_duration_s: int = Field(ge=5, le=300)
    interruptions: list[Interruption] = Field(default_factory=list, max_length=200)
    samples: list[Sample] = Field(min_length=2, max_length=60000)

    @model_validator(mode='after')
    def timestamps(self):
        first = self.samples[0]
        if abs(first.t) > 1e-6:
            raise ValueError('First relative timestamp must be zero')
        for a, b in zip(self.samples, self.samples[1:]):
            if b.t <= a.t or b.sensor_timestamp <= a.sensor_timestamp:
                raise ValueError('Timestamps must be strictly increasing')
            if abs((b.sensor_timestamp - first.sensor_timestamp) - b.t) > 0.002:
                raise ValueError('Relative and sensor timestamps disagree')
        if self.samples[-1].t > self.requested_duration_s + 2:
            raise ValueError('Samples exceed requested duration')
        return self
