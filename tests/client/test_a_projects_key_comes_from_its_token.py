"""A project's key is derived from its token, the same way every time.

The project module defines a fixed namespace, `PROJECT_KEY_NAMESPACE`, and
`project_key_for_token(token)`, which returns
`str(uuid.uuid5(PROJECT_KEY_NAMESPACE, token))`. The board's own key
idempotence then returns the same project on every re-run.

Both are reached through the core, which re-exports them; where they are
defined is pinned by `test_project_meta_lives_in_the_project_module`.

The namespace's value is the implementation's choice: it is read from the
loaded module here, never invented. What is pinned is that it is a
`uuid.UUID`, that two independent loads agree on it (it is a constant, not
drawn at import), and that the key is the uuid5 of the token under it.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_a_projects_key_comes_from_its_token
"""

import unittest
import uuid

from tests.client.live_run_harness import load_client


def _require(test, core, name):
    if not hasattr(core, name):
        test.fail(f"the core carries no `{name}`: the project module that "
                  f"defines it is not loaded and re-exported yet")
    return getattr(core, name)


class AProjectsKeyComesFromItsTokenTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("_crucible_axi.py")

    def namespace(self):
        return _require(self, self.core, "PROJECT_KEY_NAMESPACE")

    def key_for(self, token):
        return _require(self, self.core, "project_key_for_token")(token)

    def test_the_namespace_is_a_uuid(self):
        self.assertIsInstance(self.namespace(), uuid.UUID)

    def test_the_namespace_is_the_same_on_an_independent_load_of_the_core(self):
        other = load_client("_crucible_axi.py")
        self.assertEqual(
            _require(self, other, "PROJECT_KEY_NAMESPACE"), self.namespace(),
            "the namespace is a fixed constant: two loads of the core agree, so "
            "a token gives the same key in every process")
        self.assertEqual(
            _require(self, other, "project_key_for_token")("crucible"),
            self.key_for("crucible"))

    def test_the_key_is_the_uuid5_of_the_token_under_the_namespace(self):
        for token in ("crucible", "model-b", "a", "0-project-9"):
            with self.subTest(token=token):
                self.assertEqual(
                    self.key_for(token),
                    str(uuid.uuid5(self.namespace(), token)))

    def test_the_key_is_a_version_five_uuid_in_its_canonical_text(self):
        key = self.key_for("crucible")
        self.assertIsInstance(key, str)
        parsed = uuid.UUID(key)
        self.assertEqual(parsed.version, 5)
        self.assertEqual(key, str(parsed),
                         "the key is the canonical lowercase hyphenated text")

    def test_equal_tokens_give_equal_keys(self):
        self.assertEqual(self.key_for("crucible"), self.key_for("crucible"))

    def test_different_tokens_give_different_keys(self):
        keys = {token: self.key_for(token)
                for token in ("crucible", "crucible-2", "model-b", "vidushi")}
        self.assertEqual(len(set(keys.values())), len(keys),
                         f"each token has a key of its own: {keys}")


if __name__ == "__main__":
    unittest.main()
