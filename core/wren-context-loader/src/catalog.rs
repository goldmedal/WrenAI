//! The **capability catalog**: the authored, descriptive slice of a wren project that a host may
//! hand to a planner outside the data zone. Names, types, descriptions, relationships, cube
//! members, declared time grains and date ranges — the things the schema says about itself.
//!
//! It is read from the authored project files (not from the assembled `Manifest`, which keeps no
//! `properties`) with lenient, allow-listed structs: every field that is not named here is dropped
//! on read, so a new authored field never reaches the catalog by default. Nothing in the catalog
//! is computed from data, and no SQL — `ref_sql`, view statements, calculated-column or measure
//! expressions, saved queries — is carried.
//!
//! The consuming host applies its own allow-list again when it renders the catalog into a card;
//! this module is the first of the two layers, not the only one.

use serde::{Deserialize, Serialize};

use crate::project::ProjectSources;

/// Bumped when the shape below changes incompatibly; the host checks it before reading.
pub const CATALOG_VERSION: u32 = 1;

// --- authored (lenient) shapes -----------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct Properties {
    #[serde(default)]
    description: Option<String>,
    /// Authored enum meanings, `{ "A": "active", "I": "inactive" }`. Free-form keys are kept as
    /// written; the host renders them as `value = meaning`.
    #[serde(default)]
    enum_values: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
struct ProjectFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    data_source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ColumnFile {
    name: String,
    r#type: String,
    #[serde(default)]
    not_null: Option<bool>,
    #[serde(default)]
    is_calculated: Option<bool>,
    #[serde(default)]
    is_hidden: Option<bool>,
    #[serde(default)]
    relationship: Option<String>,
    #[serde(default)]
    properties: Properties,
}

#[derive(Debug, Deserialize)]
struct ModelFile {
    name: String,
    #[serde(default)]
    primary_key: Option<serde_yaml::Value>,
    #[serde(default)]
    columns: Vec<ColumnFile>,
    #[serde(default)]
    properties: Properties,
}

#[derive(Debug, Deserialize)]
struct RelationshipFile {
    name: String,
    models: Vec<String>,
    join_type: String,
    condition: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RelationshipsDoc {
    Bare(Vec<RelationshipFile>),
    Keyed {
        relationships: Vec<RelationshipFile>,
    },
}

#[derive(Debug, Deserialize)]
struct CubeMemberFile {
    name: String,
    r#type: String,
    /// Declared time grains, e.g. `[day, month, year]`; only meaningful on a time dimension.
    #[serde(default)]
    granularities: Option<Vec<String>>,
    /// Declared inclusive date range `[start, end]`; only meaningful on a time dimension.
    #[serde(default)]
    date_range: Option<Vec<String>>,
    #[serde(default)]
    properties: Properties,
}

#[derive(Debug, Deserialize)]
struct CubeFile {
    name: String,
    base_object: String,
    #[serde(default)]
    measures: Vec<CubeMemberFile>,
    #[serde(default)]
    dimensions: Vec<CubeMemberFile>,
    #[serde(default)]
    time_dimensions: Vec<CubeMemberFile>,
    #[serde(default)]
    properties: Properties,
}

#[derive(Debug, Deserialize)]
struct ViewMetaFile {
    name: String,
    #[serde(default)]
    properties: Properties,
}

// --- catalog (emitted) shapes ------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogEnumValue {
    pub value: String,
    pub meaning: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogColumn {
    pub name: String,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_null: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_calculated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relationship: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub enum_values: Vec<CatalogEnumValue>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogModel {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub primary_key: Vec<String>,
    pub columns: Vec<CatalogColumn>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogRelationship {
    pub name: String,
    pub models: Vec<String>,
    pub join_type: String,
    pub condition: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogCubeMember {
    pub name: String,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub granularities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_range: Option<[String; 2]>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogCube {
    pub name: String,
    pub base_object: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub measures: Vec<CatalogCubeMember>,
    pub dimensions: Vec<CatalogCubeMember>,
    pub time_dimensions: Vec<CatalogCubeMember>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogView {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogProject {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_source: Option<String>,
}

/// The whole catalog. Field order is the serialization order; arrays keep the sorted file order
/// [`crate::read_project_dir`] produces, so the same project always yields the same bytes.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CapabilityCatalog {
    pub catalog_version: u32,
    pub project: CatalogProject,
    pub models: Vec<CatalogModel>,
    pub relationships: Vec<CatalogRelationship>,
    pub cubes: Vec<CatalogCube>,
    pub views: Vec<CatalogView>,
    /// Files that did not parse, by kind; the catalog is still emitted without them.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub diagnostics: Vec<String>,
}

fn primary_key(value: Option<serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::String(one)) => vec![one],
        Some(serde_yaml::Value::Sequence(many)) => many
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn enum_values(value: Option<serde_yaml::Value>) -> Vec<CatalogEnumValue> {
    let mut out = Vec::new();
    match value {
        Some(serde_yaml::Value::Mapping(map)) => {
            for (key, meaning) in map {
                if let (Some(value), Some(meaning)) = (scalar(&key), scalar(&meaning)) {
                    out.push(CatalogEnumValue { value, meaning });
                }
            }
        }
        Some(serde_yaml::Value::Sequence(items)) => {
            for item in items {
                if let serde_yaml::Value::Mapping(map) = item {
                    let value = map.get("value").and_then(scalar);
                    let meaning = map.get("meaning").and_then(scalar);
                    if let (Some(value), Some(meaning)) = (value, meaning) {
                        out.push(CatalogEnumValue { value, meaning });
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn scalar(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn member(m: CubeMemberFile) -> CatalogCubeMember {
    let date_range = m.date_range.and_then(|range| match range.as_slice() {
        [start, end] => Some([start.clone(), end.clone()]),
        _ => None,
    });
    CatalogCubeMember {
        name: m.name,
        r#type: m.r#type,
        description: m.properties.description,
        granularities: m.granularities.unwrap_or_default(),
        date_range,
    }
}

fn cube(c: CubeFile) -> CatalogCube {
    CatalogCube {
        name: c.name,
        base_object: c.base_object,
        description: c.properties.description,
        measures: c.measures.into_iter().map(member).collect(),
        dimensions: c.dimensions.into_iter().map(member).collect(),
        time_dimensions: c.time_dimensions.into_iter().map(member).collect(),
    }
}

/// Build the capability catalog from read project sources. Parse failures of individual files
/// are recorded in `diagnostics` and the file is skipped; the catalog never fails as a whole.
pub fn capability_catalog(sources: &ProjectSources) -> CapabilityCatalog {
    let mut diagnostics = Vec::new();
    let project = match serde_yaml::from_str::<ProjectFile>(&sources.wren_project_yml) {
        Ok(p) => CatalogProject {
            name: p.name,
            data_source: p.data_source,
        },
        Err(e) => {
            diagnostics.push(format!("wren_project.yml: {e}"));
            CatalogProject {
                name: None,
                data_source: None,
            }
        }
    };

    let mut models = Vec::new();
    for (index, yml) in sources.model_ymls.iter().enumerate() {
        match serde_yaml::from_str::<ModelFile>(yml) {
            Ok(m) => models.push(CatalogModel {
                name: m.name,
                description: m.properties.description,
                primary_key: primary_key(m.primary_key),
                columns: m
                    .columns
                    .into_iter()
                    .map(|c| CatalogColumn {
                        name: c.name,
                        r#type: c.r#type,
                        description: c.properties.description,
                        not_null: c.not_null,
                        is_calculated: c.is_calculated,
                        is_hidden: c.is_hidden,
                        relationship: c.relationship,
                        enum_values: enum_values(c.properties.enum_values),
                    })
                    .collect(),
            }),
            Err(e) => diagnostics.push(format!("model[{index}]: {e}")),
        }
    }

    let mut relationships = Vec::new();
    if let Some(yml) = &sources.relationships_yml {
        let is_empty = serde_yaml::from_str::<serde_yaml::Value>(yml)
            .map(|v| v.is_null())
            .unwrap_or(false);
        if !is_empty {
            match serde_yaml::from_str::<RelationshipsDoc>(yml) {
                Ok(doc) => {
                    let list = match doc {
                        RelationshipsDoc::Bare(v) => v,
                        RelationshipsDoc::Keyed { relationships } => relationships,
                    };
                    relationships.extend(list.into_iter().map(|r| CatalogRelationship {
                        name: r.name,
                        models: r.models,
                        join_type: r.join_type,
                        condition: r.condition,
                    }));
                }
                Err(e) => diagnostics.push(format!("relationships.yml: {e}")),
            }
        }
    }

    let mut cubes = Vec::new();
    match &sources.cubes_yml {
        Some(yml) => match serde_yaml::from_str::<Vec<CubeFile>>(yml) {
            Ok(list) => cubes.extend(list.into_iter().map(cube)),
            Err(e) => diagnostics.push(format!("cubes.yml: {e}")),
        },
        None => {
            for (index, yml) in sources.cube_ymls.iter().enumerate() {
                match serde_yaml::from_str::<CubeFile>(yml) {
                    Ok(c) => cubes.push(cube(c)),
                    Err(e) => diagnostics.push(format!("cube[{index}]: {e}")),
                }
            }
        }
    }

    let mut views = Vec::new();
    for (index, (meta_yml, _sql_yml)) in sources.views.iter().enumerate() {
        match serde_yaml::from_str::<ViewMetaFile>(meta_yml) {
            Ok(v) => views.push(CatalogView {
                name: v.name,
                description: v.properties.description,
            }),
            Err(e) => diagnostics.push(format!("view[{index}]: {e}")),
        }
    }

    CapabilityCatalog {
        catalog_version: CATALOG_VERSION,
        project,
        models,
        relationships,
        cubes,
        views,
        diagnostics,
    }
}

/// Render the catalog as its JSON document (pretty-printed, stable field order).
pub fn catalog_document(catalog: &CapabilityCatalog) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(model_yml: &str) -> ProjectSources {
        ProjectSources {
            wren_project_yml: "schema_version: 5\nname: demo\ndata_source: duckdb\n".into(),
            model_ymls: vec![model_yml.into()],
            relationships_yml: None,
            cubes_yml: None,
            cube_ymls: Vec::new(),
            views: Vec::new(),
            knowledge_sql_mds: Vec::new(),
            dashboards_yml: None,
        }
    }

    #[test]
    fn keeps_descriptions_and_enum_meanings_and_drops_everything_else() {
        let catalog = capability_catalog(&sources(
            r#"name: orders
ref_sql: SELECT * FROM raw_orders WHERE deleted_at IS NULL
properties:
  description: One row per order.
  sample_values: [1, 2, 3]
columns:
  - name: status
    type: VARCHAR
    properties:
      description: "[enum] see enum_values"
      enum_values: { A: active, I: inactive }
      sample_values: [A, I]
  - name: total_cents
    type: BIGINT
    is_calculated: true
    expression: amount * 100
"#,
        ));
        let json = catalog_document(&catalog).unwrap();
        assert!(json.contains("One row per order."));
        assert!(json.contains("\"meaning\": \"active\""));
        assert!(!json.contains("SELECT"));
        assert!(!json.contains("sample_values"));
        assert!(!json.contains("amount * 100"));
        assert_eq!(catalog.models[0].columns[1].is_calculated, Some(true));
        assert!(catalog.diagnostics.is_empty());
    }

    #[test]
    fn a_broken_file_is_a_diagnostic_not_a_failure() {
        let catalog = capability_catalog(&sources("name: [unclosed"));
        assert!(catalog.models.is_empty());
        assert_eq!(catalog.diagnostics.len(), 1);
    }
}
