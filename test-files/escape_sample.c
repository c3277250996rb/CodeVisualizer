/* 转义样例：!= 不能被渲染成不等号，字符串里的反斜杠要原样显示成单个。 */
int escape_sample(int value) {
	if (value != 0) {
		MyUart_WriteString("V\r\n");
	}
	return value;
}
