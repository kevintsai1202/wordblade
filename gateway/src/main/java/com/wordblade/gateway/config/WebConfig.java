package com.wordblade.gateway.config;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** MVC 設定：CORS 放行清單與權杖驗證攔截器。 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final GatewayProperties props;
    private final TokenAuthInterceptor authInterceptor;

    public WebConfig(GatewayProperties props, TokenAuthInterceptor authInterceptor) {
        this.props = props;
        this.authInterceptor = authInterceptor;
    }

    /** CORS 由設定讀取放行清單；Spring MVC 的 CorsInterceptor 先於驗證攔截器，所以 401 也帶 CORS 標頭。 */
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/v1/**")
                .allowedOrigins(props.corsAllowedOrigins().toArray(String[]::new))
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }

    /** 所有 /v1/** 路由都要 Bearer 權杖。 */
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor).addPathPatterns("/v1/**");
    }
}
