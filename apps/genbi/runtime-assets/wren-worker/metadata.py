"""Record immutable build inputs and the actual installed Linux closure."""
import importlib.metadata
import json
from pathlib import Path
import platform

root = Path('/opt/genbi')
metadata = json.loads((root / 'metadata-input.json').read_text())
metadata.update(
    python=platform.python_version(),
    architecture=platform.machine(),
    distributions=sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions()),
)
(root / 'toolchain.json').write_text(json.dumps(metadata, sort_keys=True, separators=(',', ':')) + '\n')
