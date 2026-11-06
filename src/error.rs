use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};

#[derive(Debug)]
pub enum AppError {
    NotFound,
    BadRequest(String),
    Forbidden(String),
    /// Not signed in: send the browser to the login page.
    Login(String),
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            AppError::Login(next) => {
                let target = format!(
                    "/login?next={}",
                    url::form_urlencoded::byte_serialize(next.as_bytes()).collect::<String>()
                );
                return Redirect::to(&target).into_response();
            }
            AppError::Internal(e) => {
                tracing::error!("{e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong".to_string())
            }
        };
        (status, crate::web::layout::error_page(status, &msg)).into_response()
    }
}
