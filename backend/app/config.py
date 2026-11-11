from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    database_url: str = 'postgresql+psycopg://silentlink@db/silentlink'
    data_dir: Path = Path('/data/recordings')
    max_upload_bytes: int = 12 * 1024 * 1024
    rate_limit_per_minute: int = 120


settings = Settings()
