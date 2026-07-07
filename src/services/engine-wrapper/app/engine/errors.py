"""Engine error types (own module so approaches/newton/waterfall avoid import cycles)."""


class EngineInputError(ValueError):
    """A required input for a weighted approach is missing/invalid."""
