"""Initial research metadata schema."""
from alembic import op
import sqlalchemy as sa

revision = '0001'
down_revision = None


def upgrade():
    op.create_table('api_keys', sa.Column('digest', sa.String(64), primary_key=True), sa.Column('owner', sa.String(64), nullable=False), sa.Column('device', sa.String(128), nullable=False))
    op.create_index('ix_api_keys_owner', 'api_keys', ['owner'])
    op.create_table('sessions', sa.Column('id', sa.String(36), primary_key=True), sa.Column('owner', sa.String(64), nullable=False), sa.Column('experiment', sa.String(120), nullable=False), sa.Column('device', sa.String(128), nullable=False), sa.Column('started_at', sa.DateTime(timezone=True), nullable=False), sa.Column('notes', sa.Text(), nullable=False), sa.Column('protocol_version', sa.String(40), nullable=False))
    op.create_index('ix_sessions_owner', 'sessions', ['owner'])
    op.create_table('recordings', sa.Column('id', sa.String(36), primary_key=True), sa.Column('owner', sa.String(64), nullable=False), sa.Column('session_id', sa.String(36), sa.ForeignKey('sessions.id'), nullable=False), sa.Column('label', sa.String(160), nullable=False), sa.Column('recording_type', sa.String(32), nullable=False), sa.Column('started_at', sa.DateTime(timezone=True), nullable=False), sa.Column('sample_count', sa.Integer(), nullable=False), sa.Column('digest', sa.String(64), nullable=False), sa.Column('filename', sa.String(200), nullable=False), sa.Column('stats_json', sa.Text(), nullable=False), sa.Column('created_at', sa.DateTime(timezone=True), nullable=False), sa.UniqueConstraint('owner', 'id', name='uq_recording_owner_id'))
    for key in ('owner', 'session_id', 'label'):
        op.create_index(f'ix_recordings_{key}', 'recordings', [key])


def downgrade():
    op.drop_table('recordings')
    op.drop_table('sessions')
    op.drop_table('api_keys')
