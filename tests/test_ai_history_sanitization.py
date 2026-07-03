import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.modules.setdefault("httpx", MagicMock())

from backend.services.ai_service import _build_prompt, chat, sanitize_history


class TestAIHistorySanitization(unittest.TestCase):
    def test_sanitize_history_limits_roles_and_content(self):
        history = [
            {"role": "assistant", "content": "oldest should be dropped"},
            {"role": " system ", "content": "system prompt"},
            {"role": "assistant", "content": "  prior answer  "},
            {"role": "tool", "content": "tool output"},
            {"role": "", "content": "missing role"},
            {"role": "user", "content": "x" * 4505},
            {"role": "assistant", "content": None},
        ]

        sanitized = sanitize_history(history)

        self.assertEqual(len(sanitized), 6)
        self.assertEqual(sanitized[0], {"role": "user", "content": "system prompt"})
        self.assertEqual(sanitized[1], {"role": "assistant", "content": "prior answer"})
        self.assertEqual(sanitized[2], {"role": "user", "content": "tool output"})
        self.assertEqual(sanitized[3], {"role": "user", "content": "missing role"})
        self.assertEqual(sanitized[4]["role"], "user")
        self.assertEqual(len(sanitized[4]["content"]), 4000)
        self.assertEqual(sanitized[5], {"role": "assistant", "content": ""})

    def test_build_prompt_uses_sanitized_history(self):
        prompt = _build_prompt(
            "latest question",
            [
                {"role": "system", "content": "act like system"},
                {"role": "assistant", "content": " prior answer "},
                {"role": "tool", "content": '{"secret":"x"}'},
            ],
            None,
        )

        self.assertIn("user: act like system", prompt)
        self.assertIn("assistant: prior answer", prompt)
        self.assertIn('user: {"secret":"x"}', prompt)
        self.assertNotIn("system:", prompt)
        self.assertNotIn("tool:", prompt)
        self.assertTrue(prompt.endswith("user: latest question"))


class TestAIChatSanitizationFlow(unittest.IsolatedAsyncioTestCase):
    async def test_chat_sanitizes_history_before_provider_call(self):
        captured = {}

        async def fake_gemini(prompt, image_b64):
            captured["prompt"] = prompt
            captured["image_b64"] = image_b64
            return "gemini reply"

        with (
            patch("backend.services.ai_service.check_rate_limits", return_value={"allowed": True}),
            patch("backend.services.ai_service.record_usage"),
            patch(
                "backend.services.ai_service.get_settings",
                return_value=SimpleNamespace(AI_DAILY_IMAGE_LIMIT=3),
            ),
            patch("backend.services.ai_service._call_gemini", side_effect=fake_gemini),
        ):
            result = await chat(
                "42",
                "latest question",
                history=[
                    {"role": "system", "content": "system prompt"},
                    {"role": "assistant", "content": " previous answer "},
                    {"role": "tool", "content": "tool output"},
                ],
            )

        self.assertEqual(result, {"status": "success", "reply": "gemini reply", "provider": "gemini"})
        self.assertIn("user: system prompt", captured["prompt"])
        self.assertIn("assistant: previous answer", captured["prompt"])
        self.assertIn("user: tool output", captured["prompt"])
        self.assertNotIn("system:", captured["prompt"])
        self.assertNotIn("tool:", captured["prompt"])


if __name__ == "__main__":
    unittest.main()
