use reqwest::{redirect::Policy, Url};

fn redirect_allowed(url: &Url, allowed: fn(&str) -> bool) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(allowed)
}

/// Apply the service's host allowlist before following each redirect.
pub(crate) fn https_redirect_policy(allowed: fn(&str) -> bool) -> Policy {
    Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("request followed too many redirects")
        } else if redirect_allowed(attempt.url(), allowed) {
            attempt.follow()
        } else {
            attempt.error("request was redirected outside its trusted HTTPS hosts")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed_host(host: &str) -> bool {
        host == "api.github.com"
    }

    #[test]
    fn redirects_require_an_allowed_https_host() {
        assert!(redirect_allowed(
            &Url::parse("https://api.github.com/releases").unwrap(),
            allowed_host,
        ));
        for url in [
            "https://example.com/releases",
            "https://api.github.com.example.com/releases",
            "https://127.0.0.1/releases",
            "http://api.github.com/releases",
        ] {
            assert!(
                !redirect_allowed(&Url::parse(url).unwrap(), allowed_host),
                "{url}"
            );
        }
    }
}
