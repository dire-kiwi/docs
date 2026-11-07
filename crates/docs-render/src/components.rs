//! The MDX components agents can use, documented once for the website,
//! the MCP `list_components` tool and the MCP server instructions.

pub struct Prop {
    pub name: &'static str,
    pub doc: &'static str,
}

pub struct ComponentDoc {
    pub name: &'static str,
    pub summary: &'static str,
    pub props: &'static [Prop],
    /// Shape of the stored answer, for form fields.
    pub answer: Option<&'static str>,
    pub example: &'static str,
}

const fn p(name: &'static str, doc: &'static str) -> Prop {
    Prop { name, doc }
}

const NAME: Prop = p(
    "name",
    "Required. Unique per page; answers are reported under this key.",
);
const LABEL: Prop = p("label", "Question shown to the reader.");
const HELP: Prop = p("help", "Optional help text. Markdown children work too.");
const REQUIRED: Prop = p("required", "Marks the field as required (shown to the reader).");
const OPTIONS: Prop = p(
    "options",
    "List of choices: options={[\"A\", \"B\"]}, options={[{value: \"a\", label: \"A\"}]} or options=\"A, B\".",
);

pub const COMPONENTS: &[ComponentDoc] = &[
    ComponentDoc {
        name: "Callout",
        summary: "A highlighted box for notes, warnings and key decisions.",
        props: &[
            p("type", "note (default), info, tip, success, warning or danger."),
            p("title", "Optional heading."),
        ],
        answer: None,
        example: "<Callout type=\"warning\" title=\"Breaking change\">\n  The `v1` API is removed in phase 2.\n</Callout>",
    },
    ComponentDoc {
        name: "Details",
        summary: "A collapsible section.",
        props: &[p("summary", "Text shown when collapsed."), p("open", "Start expanded.")],
        answer: None,
        example: "<Details summary=\"Raw benchmark numbers\">\n\n| run | ms |\n|-----|----|\n| 1   | 12 |\n\n</Details>",
    },
    ComponentDoc {
        name: "TextInput",
        summary: "A single-line text answer.",
        props: &[NAME, LABEL, p("placeholder", "Placeholder text."), HELP, REQUIRED],
        answer: Some("string"),
        example: "<TextInput name=\"owner\" label=\"Who should own this work?\" placeholder=\"GitHub username\" />",
    },
    ComponentDoc {
        name: "TextArea",
        summary: "A multi-line text answer.",
        props: &[
            NAME,
            LABEL,
            p("placeholder", "Placeholder text."),
            p("rows", "Height in lines (default 4)."),
            HELP,
            REQUIRED,
        ],
        answer: Some("string"),
        example: "<TextArea name=\"concerns\" label=\"Any concerns with this approach?\" rows={3} />",
    },
    ComponentDoc {
        name: "Select",
        summary: "Pick one option from a dropdown.",
        props: &[NAME, LABEL, OPTIONS, HELP, REQUIRED],
        answer: Some("string (the chosen value)"),
        example: "<Select name=\"region\" label=\"Deploy region\" options={[\"us-east\", \"eu-west\", \"ap-southeast\"]} />",
    },
    ComponentDoc {
        name: "RadioGroup",
        summary: "Pick one option, with every option visible.",
        props: &[NAME, LABEL, OPTIONS, HELP, REQUIRED],
        answer: Some("string (the chosen value)"),
        example: "<RadioGroup name=\"database\" label=\"Which database?\" options={[\"SQLite\", \"Postgres\"]} />",
    },
    ComponentDoc {
        name: "CheckboxGroup",
        summary: "Pick any number of options.",
        props: &[NAME, LABEL, OPTIONS, HELP],
        answer: Some("array of chosen values"),
        example: "<CheckboxGroup name=\"phases\" label=\"Which phases should go ahead?\" options={[\"Phase 1\", \"Phase 2\", \"Phase 3\"]} />",
    },
    ComponentDoc {
        name: "Checkbox",
        summary: "A single yes/no tick box.",
        props: &[NAME, LABEL, HELP],
        answer: Some("boolean"),
        example: "<Checkbox name=\"tests\" label=\"Add integration tests\" />",
    },
    ComponentDoc {
        name: "Scale",
        summary: "A numeric rating, e.g. confidence from 1 to 5.",
        props: &[
            NAME,
            LABEL,
            p("min", "Lowest value (default 1)."),
            p("max", "Highest value (default 5)."),
            p("minLabel", "Text next to the lowest value."),
            p("maxLabel", "Text next to the highest value."),
            HELP,
        ],
        answer: Some("number"),
        example: "<Scale name=\"confidence\" label=\"How confident are you in this estimate?\" minLabel=\"Not at all\" maxLabel=\"Very\" />",
    },
    ComponentDoc {
        name: "Approval",
        summary: "Approve, request changes or reject, with an optional comment. Use one per plan or decision.",
        props: &[
            p("name", "Defaults to \"approval\"."),
            p("label", "Defaults to \"Do you approve this?\"."),
            HELP,
        ],
        answer: Some("{\"decision\": \"approve\" | \"changes\" | \"reject\", \"comment\": string}"),
        example: "<Approval name=\"plan\" label=\"Approve this plan?\" />",
    },
];

/// Markdown reference for agents.
pub fn reference() -> String {
    let mut s = String::from(
        "# MDX components\n\n\
         Pages with format \"mdx\" can use these components. Only these are available: \
         there is no `import`, and `{expressions}` are not evaluated (MDX comments `{/* … */}` are fine). \
         Attribute values may be strings (`a=\"x\"`) or JSON-like literals (`a={3}`, `a={[\"x\", \"y\"]}`). \
         Lowercase HTML elements such as `<details>` or `<kbd>` also work.\n\n\
         Form fields save the reader's answers as they type; read them back with the `get_feedback` tool. \
         Readers can also select any text on a page and leave a comment on it; those come back from `get_feedback` too.\n",
    );
    for c in COMPONENTS {
        s.push_str(&format!("\n## {}\n\n{}\n\n", c.name, c.summary));
        for prop in c.props {
            s.push_str(&format!("- `{}`: {}\n", prop.name, prop.doc));
        }
        if let Some(a) = c.answer {
            s.push_str(&format!("\nAnswer: {a}\n"));
        }
        s.push_str(&format!("\n```mdx\n{}\n```\n", c.example));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{Format, Options, render};
    use std::collections::HashMap;

    #[test]
    fn examples_render_cleanly() {
        let answers = HashMap::new();
        let opts = Options {
            page_path: "index",
            base_url: "/",
            answers: &answers,
        };
        for c in COMPONENTS {
            let r = render(c.example, Format::Mdx, &opts).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            assert!(r.warnings.is_empty(), "{}: {:?}", c.name, r.warnings);
            assert_eq!(r.fields.len(), usize::from(c.answer.is_some()), "{}", c.name);
        }
    }
}
