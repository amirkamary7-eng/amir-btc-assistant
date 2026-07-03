import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


sqlalchemy_module = types.ModuleType("sqlalchemy")
sqlalchemy_orm_module = types.ModuleType("sqlalchemy.orm")
sqlalchemy_orm_module.Session = object
sys.modules.setdefault("sqlalchemy", sqlalchemy_module)
sys.modules.setdefault("sqlalchemy.orm", sqlalchemy_orm_module)

models_module = types.ModuleType("backend.models")


class Referral:
    invitee_id = "invitee_id"


models_module.Referral = Referral
sys.modules.setdefault("backend.models", models_module)

referral_service_module = types.ModuleType("backend.services.referral_service")
referral_service_module.process_referral_on_bootstrap = lambda *args, **kwargs: None
sys.modules.setdefault("backend.services.referral_service", referral_service_module)

user_service_module = types.ModuleType("backend.services.user_service")
user_service_module.get_user = lambda *args, **kwargs: None
user_service_module.set_user_channel_joined = lambda *args, **kwargs: None
sys.modules.setdefault("backend.services.user_service", user_service_module)

from backend.services.join_service import resolve_channel_membership


class TestJoinServiceAdminBypass(unittest.TestCase):
    def test_secondary_admin_skips_join_check(self):
        def telegram_check(_uid: str) -> dict:
            raise AssertionError("telegram_check should not be called for admins")

        with patch(
            "backend.services.join_service.get_settings",
            return_value=SimpleNamespace(
                ADMIN_TELEGRAM_ID="831704732",
                admin_ids={"831704732", "999999"},
            ),
        ):
            result = resolve_channel_membership("999999", telegram_check)

        self.assertEqual(result, {"joined": True, "admin": True})


if __name__ == "__main__":
    unittest.main()
