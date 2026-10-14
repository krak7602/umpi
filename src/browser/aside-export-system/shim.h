#include <sqlite3.h>
#include <CommonCrypto/CommonCrypto.h>
#include "public-suffixes.h"

static inline int aside_export_cookie_domain(const char *host, const char *domain) {
    if (*host == '.') host++;
    if (!aside_export_dns_host(host)) return 0;
    size_t host_size = strlen(host), domain_size = strlen(domain);
    if (host_size < domain_size || memcmp(host + host_size - domain_size, domain, domain_size)) return 0;
    return host_size == domain_size || host[host_size - domain_size - 1] == '.';
}

static inline int aside_export_public_domain(const char *domain) {
    if (!aside_export_registrable_domain(domain)) return 0;
    const char *suffix = strrchr(domain, '.');
    suffix = suffix ? suffix + 1 : domain;
    return strcmp(suffix, "arpa") && strcmp(suffix, "onion") &&
        strcmp(suffix, "localhost") && strcmp(suffix, "local") &&
        strcmp(suffix, "internal") && strcmp(suffix, "test") &&
        strcmp(suffix, "invalid") && strcmp(suffix, "example");
}
