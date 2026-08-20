//! `to_columns` — the numeric way out of a run.
//!
//! The property that matters is that it says the SAME thing as the text output:
//! a second way to read one run, not a second run.

use tdcv2::{Column, Tdc};

const CONFIG: &str = r#"<tdc><env count="4" seed="c"><sequence name="N"><gen type="increment" value="1"/></sequence><sequence name="MV"><gen type="formula" expr="gauss(N, 2, 1)"/></sequence><sequence name="Label"><gen type="text" value="a,b" percent="50,50"/></sequence></env><block><line><data>${{N}}</data></line></block></tdc>"#;

#[test]
fn to_columns_agrees_with_the_text_output() {
    let tdc = Tdc::from_string(CONFIG).expect("config");
    let columns = tdc.to_columns();
    let text = tdc.to_string();
    let rows: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(rows.len(), 4);

    let by = |name: &str| {
        columns
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, c)| c.clone())
            .expect("column")
    };

    // A column of numbers is Numbers; anything else stays Text.
    match by("N") {
        Column::Numbers(v) => {
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(v[i], row.parse::<f64>().expect("number"));
            }
        }
        Column::Text(_) => panic!("N should be numeric"),
    }
    assert!(matches!(by("MV"), Column::Numbers(_)));
    assert!(matches!(by("Label"), Column::Text(_)));
}
