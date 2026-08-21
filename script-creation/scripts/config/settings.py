"""配置管理：环境变量 + 飞书表配置。"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── LLM (inferera / deepseek-v4-pro) ──
    deepseek_api_key: str
    deepseek_base_url: str = "https://api.inferera.com/v1"
    deepseek_model: str = "deepseek-v4-pro"

    # ── 代理 ──
    http_proxy: str | None = None
    https_proxy: str | None = None


# ── 飞书多维表格配置（非密钥，硬编码） ──

# 网络素材库
FEISHU_MATERIALS_BASE = "RFAqblL7FahLxps2SsNcoyxjnWh"
FEISHU_MATERIALS_TABLE = "tblYEQ0raRDrB4tb"

# 历史数据库（仅头条表参与匹配，视频号表字段不全已排除）
FEISHU_HISTORY_BASE = "IusNb2cgTafYo4sTVntcHNJHn9f"
FEISHU_HISTORY_TABLE_TOUTIAO = "tblBEveR1P0gKRyy"

# 内容标准文档（创意产出前必读：转化链条/切入方向/铺垫转折三方向硬约束）
CONTENT_STANDARD_DOC_URL = "https://kwza968lz1u.feishu.cn/docx/ZdJMd6L1uo7lkwxSgKkcvXawnLc"


def get_settings() -> Settings:
    return Settings()
