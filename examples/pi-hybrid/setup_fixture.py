"""Create an owned synthetic Jaffle project; never configure the user's Wren."""

import argparse
import json
import shutil
from pathlib import Path

import duckdb
import yaml


def prepare(destination: Path) -> None:
    destination.mkdir(mode=0o700)  # refuse existing directories
    source = Path(__file__).resolve().parents[1] / "v5-jaffle"
    project = destination / "project"
    for relative in [
        "wren_project.yml",
        "models/orders/metadata.yml",
        "models/orders/ref_sql.sql",
        "models/customers/metadata.yml",
        "relationships.yml",
        "knowledge/knowledge.yml",
        "knowledge/rules/business-rules.md",
        "knowledge/sql/total-revenue.md",
    ]:
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    shutil.copyfile(
        Path(__file__).with_name("weekly-target.md"),
        project / "knowledge/rules/weekly-target.md",
    )
    config = yaml.safe_load((project / "wren_project.yml").read_text())
    config["data_source"] = "local_file"
    config["profile"] = "fixture"
    (project / "wren_project.yml").write_text(yaml.safe_dump(config))
    (project / "models/orders/ref_sql.sql").write_text(
        "SELECT id, customer_id, order_date, amount FROM jaffle.main.raw_orders\n"
    )
    customer_file = project / "models/customers/metadata.yml"
    customer = yaml.safe_load(customer_file.read_text())
    customer["table_reference"] = {
        "catalog": "jaffle",
        "schema": "main",
        "table": "customers",
    }
    customer_file.write_text(yaml.safe_dump(customer))
    data = destination / "data"
    data.mkdir()
    with duckdb.connect(str(data / "jaffle.duckdb")) as db:
        db.execute(
            "CREATE TABLE raw_orders(id INTEGER, customer_id INTEGER, order_date TIMESTAMP, amount DOUBLE)"
        )
        db.execute(
            "INSERT INTO raw_orders VALUES "
            "(1,1,'2025-12-29 00:00:00',10),"
            "(2,2,'2026-01-01',20),(3,1,'2026-01-04 23:59:59',30),"
            "(4,3,'2026-01-05 00:00:00',40),(5,1,'2026-01-07',10),"
            "(6,2,'2026-01-09',20),(7,3,'2026-01-11 23:59:59',30),"
            "(8,1,'2026-01-12 00:00:00',40),(9,2,'2026-01-13',10),"
            "(10,3,'2026-01-14',20),(11,1,'2026-01-16',30),"
            "(12,2,'2026-01-18 23:59:59',40)"
        )
        db.execute("CREATE TABLE customers(id INTEGER, name VARCHAR)")
        db.execute(
            "INSERT INTO customers VALUES (1,'RAW_CUSTOMER_CANARY'),(2,'Synthetic B'),(3,'Synthetic C')"
        )
    home = destination / "home"
    wren_home = home / ".wren"
    wren_home.mkdir(parents=True)
    (wren_home / "profiles.yml").write_text(
        yaml.safe_dump(
            {
                "active": "fixture",
                "profiles": {
                    "fixture": {
                        "datasource": "local_file",
                        "url": str(data),
                        "format": "duckdb",
                    }
                },
            }
        )
    )
    (destination / "fixture.json").write_text(
        json.dumps({"project": str(project), "home": str(home)})
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    prepare(parser.parse_args().destination.resolve())
