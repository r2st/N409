"""Engine error types (own module so approaches/newton/waterfall avoid import cycles)."""


class EngineInputError(ValueError):
    """A required input for a weighted approach is missing/invalid."""


class EngineDegradedError(EngineInputError):
    """A refusal the caller's inputs did not earn.

    Every ``EngineInputError`` becomes a 422, and ``errors.py`` states the rule
    that follows from that: "4xx stays unlogged. Those describe the request,
    the caller was told, and their rate is set by whoever is making the
    mistakes." True of the other seventeen raise sites and false of this one.

    A Monte Carlo run refused for value conservation was asked for with a
    volatility inside ``validate.VOLATILITY_BAND``, a horizon nobody warns
    about and the path count this engine chooses when the caller does not. The
    request is not wrong; the *estimator* failed on it, in a regime the module
    documents and the response cannot otherwise report — the run raises instead
    of answering, so there is no ``value_conservation`` block for anyone to
    read. The analyst is told to raise the path count. Nobody else is told
    anything, and the one question worth asking of a refusal like this is how
    often it is happening, which is exactly the question a log answers and a
    per-request 422 does not.

    So it is a distinct type rather than a message an operator would have to
    match: ``event`` names the condition for a grep and ``facts`` carries the
    figures already computed, so the line is structured rather than a re-parse
    of the prose the caller sees.
    """

    def __init__(self, message: str, *, event: str, **facts: float) -> None:
        super().__init__(message)
        self.event = event
        self.facts = facts
